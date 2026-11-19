// Offline search + road alerts for one India zone (run by .github/workflows/poi.yml):
//   poi-out/<zone>.poi.tsv   lon  lat  category  name  info(opening_hours|phone|brand)  — places, POIs, streets
//   poi-out/<zone>.alerts.tsv lon lat kind  — speed cameras, speed breakers, rail crossings, tolls, signals, zebra crossings
// Usage: node tools/build-poi.mjs <zone>   (PBF=/path/file.osm.pbf to use a local extract)
import { createReadStream } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import readline from 'node:readline';

const zone = process.argv[2] ?? 'southern-zone';
const OUT = 'poi-out';
await mkdir(OUT, { recursive: true });
const pbf = process.env.PBF ?? `/tmp/${zone}.osm.pbf`;
if (!process.env.PBF) execSync(`curl -fsSL --retry 6 --retry-delay 20 --retry-all-errors -o ${pbf} https://download.geofabrik.de/asia/india/${zone}-latest.osm.pbf`, { stdio: 'inherit' });
const t0 = Date.now();

// category = first matching rule; the app groups and labels them
const RULES = [
  ['amenity', { fuel: 'fuel', charging_station: 'ev', atm: 'atm', bank: 'bank', hospital: 'hospital', clinic: 'clinic', doctors: 'clinic', pharmacy: 'pharmacy', police: 'police',
    restaurant: 'restaurant', fast_food: 'fast_food', cafe: 'cafe', food_court: 'restaurant', toilets: 'toilets', parking: 'parking', motorcycle_parking: 'parking',
    bus_station: 'bus', place_of_worship: 'worship', drinking_water: 'water', fire_station: 'fire', post_office: 'post', marketplace: 'market', car_wash: 'wash', school: 'school', college: 'school', university: 'school' }],
  ['shop', { motorcycle: 'moto_shop', motorcycle_repair: 'mechanic', car_repair: 'mechanic', tyres: 'tyres', supermarket: 'supermarket', convenience: 'shop', bakery: 'food_shop', mall: 'mall', '*': 'shop' }],
  ['craft', { motorcycle_repair: 'mechanic', '*': null }],
  ['tourism', { hotel: 'hotel', guest_house: 'guest_house', hostel: 'hostel', motel: 'hotel', camp_site: 'camp', attraction: 'attraction', viewpoint: 'viewpoint', museum: 'museum', picnic_site: 'picnic', information: 'info', '*': null }],
  ['historic', { '*': 'historic' }],
  ['leisure', { park: 'park', '*': null }],
  ['railway', { station: 'rail', halt: 'rail' }],
  ['aeroway', { aerodrome: 'airport' }],
  ['place', { city: 'city', town: 'town', village: 'village', hamlet: 'hamlet', suburb: 'suburb', neighbourhood: 'locality', locality: 'locality', quarter: 'locality' }],
  ['natural', { peak: 'peak', waterfall: 'waterfall', beach: 'beach' }],
  ['waterway', { waterfall: 'waterfall' }],
];
const catOf = (t) => {
  for (const [k, map] of RULES) {
    const v = t[k];
    if (v === undefined) continue;
    const c = map[v] ?? map['*'];
    if (c) return c;
  }
  if (t.highway && t.name && /^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road)(_link)?$/.test(t.highway)) return 'street';
  return null;
};
const alertOf = (t) => t.highway === 'speed_camera' ? 'camera' : t.traffic_calming && t.traffic_calming !== 'no' ? 'bump'
  : t.railway === 'level_crossing' || t.railway === 'crossing' ? 'rail' : t.barrier === 'toll_booth' ? 'toll'
  : t.highway === 'traffic_signals' ? 'signals' : t.highway === 'crossing' && (t.crossing === 'zebra' || t.crossing_ref === 'zebra' || t.crossing === 'marked') ? 'zebra'
  : t.highway === 'stop' ? 'stop' : t.hazard ? 'hazard' : null;

const keys = 'amenity shop craft tourism historic leisure railway aeroway place natural waterway'.split(' ');
execSync(`osmium tags-filter ${pbf} ${keys.map((k) => `nwr/${k}`).join(' ')} nwr/addr:housenumber w/highway n/highway=speed_camera,traffic_signals,crossing,stop n/traffic_calming n/barrier=toll_booth n/hazard -o /tmp/poi.osm.pbf --overwrite`, { stdio: 'inherit' });
execSync(`osmium export /tmp/poi.osm.pbf -f geojsonseq -o /tmp/poi.geojsonseq --overwrite`, { stdio: 'inherit' });

const clean = (s) => String(s ?? '').replace(/[\t\n\r]+/g, ' ').trim();
const r6 = (x) => Math.round(x * 1e5) / 1e5;
const rep = (g) => {
  // representative point: point itself, middle of a line, middle of a polygon's bounding box
  if (g.type === 'Point') return g.coordinates;
  const pts = g.type === 'LineString' ? g.coordinates : g.type === 'MultiLineString' ? g.coordinates.flat() : g.type === 'Polygon' ? g.coordinates[0] : g.type === 'MultiPolygon' ? g.coordinates.flat(2) : null;
  if (!pts?.length) return null;
  if (g.type.includes('LineString')) return pts[Math.floor(pts.length / 2)];
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [(a + c) / 2, (b + d) / 2];
};
const poi = [], alerts = [], streets = new Set();
const counts = {};
const rl = readline.createInterface({ input: createReadStream('/tmp/poi.geojsonseq') });
for await (const line of rl) {
  const txt = line.replace(/^\x1e/, '').trim();
  if (!txt) continue;
  const f = JSON.parse(txt), t = f.properties ?? {};
  const p = rep(f.geometry);
  if (!p) continue;
  if (f.geometry.type === 'Point') {
    const a = alertOf(t);
    if (a) { alerts.push(`${r6(p[0])}\t${r6(p[1])}\t${a}${t.maxspeed ? '\t' + clean(t.maxspeed) : ''}`); counts['alert:' + a] = (counts['alert:' + a] ?? 0) + 1; }
  }
  // house-number addresses (OsmAnd address search): "12 MG Road, Bengaluru"
  if (t['addr:housenumber'] && (t['addr:street'] || t['addr:place']) && !catOf(t)) {
    const nm = `${clean(t['addr:housenumber'])} ${clean(t['addr:street'] || t['addr:place'])}`;
    const k = `address|${nm}|${Math.round(p[0] * 2000)}|${Math.round(p[1] * 2000)}`;
    if (!streets.has(k)) { streets.add(k); poi.push(`${r6(p[0])}\t${r6(p[1])}\taddress\t${nm}\t|||${clean(t['addr:city'] || t['addr:district'] || t['addr:suburb'] || t['addr:postcode'])}`); counts.address = (counts.address ?? 0) + 1; }
    continue;
  }
  const cat = catOf(t);
  if (!cat) continue;
  const name = clean(t['name:en'] || t.name || t.brand || t.operator);
  if (!name && !['fuel', 'atm', 'toilets', 'parking', 'water', 'police', 'hospital'].includes(cat)) continue;
  // one entry per name per cell: ~1 km for streets (long roads are split into many ways), ~200 m otherwise
  // (buildings are exported both as outline and as area)
  const g = cat === 'street' ? 100 : 250;
  const k = `${cat}|${name}|${Math.round(p[0] * g)}|${Math.round(p[1] * g)}`;
  if (streets.has(k)) continue;
  streets.add(k);
  const info = [clean(t.opening_hours), clean(t.phone || t['contact:phone']), clean(t.brand), clean(t['addr:city'] || t['addr:district'] || t['is_in'])].join('|').replace(/\|+$/, '');
  poi.push(`${r6(p[0])}\t${r6(p[1])}\t${cat}\t${name}\t${info}`);
  counts[cat] = (counts[cat] ?? 0) + 1;
}
await writeFile(`${OUT}/${zone}.poi.tsv`, poi.join('\n'));
await writeFile(`${OUT}/${zone}.alerts.tsv`, alerts.join('\n'));
const stats = { zone, generated: new Date().toISOString(), poi: poi.length, alerts: alerts.length, counts, seconds: Math.round((Date.now() - t0) / 1000) };
await writeFile(`${OUT}/${zone}.poi.json`, JSON.stringify(stats, null, 1));
console.log(JSON.stringify(stats));
