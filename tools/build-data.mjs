// Builds the India data files used by the app (run by .github/workflows/data.yml, output in ./data-out):
//   expressways.json  – motorways / expressways from OpenStreetMap with two-wheeler access
//   india-states.json – state & UT boundaries (Natural Earth admin-1, public domain), simplified
//   summary.json      – counts and sizes for a quick check
// The workflow publishes them as assets of the "india-data" release; the site build downloads them.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const OUT = 'data-out';
await mkdir(OUT, { recursive: true });
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const r5 = (x) => Math.round(x * 1e5) / 1e5;

async function overpass(q) {
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ridegrid-india-data-build (github.com/lonesoull/ridegrid-india)' },
      });
      if (res.ok) return res.json();
      console.error(url, res.status, (await res.text()).slice(0, 300));
    } catch (e) { console.error(url, e.message); }
  }
  throw new Error('Overpass unavailable');
}

// ---- expressways: every motorway in India + any other road explicitly closed to motorcycles
const q = `[out:json][timeout:1200][maxsize:1073741824];
area["ISO3166-1"="IN"][admin_level=2]->.in;
( way["highway"~"^(motorway|motorway_link)$"](area.in);
  way["highway"]["motorcycle"="no"]["highway"!~"^(footway|path|cycleway|pedestrian|steps|track|service)$"](area.in); );
out tags geom;`;
const ov = await overpass(q);
const ways = ov.elements.filter((e) => e.type === 'way' && e.geometry?.length > 1);
const features = ways.map((w) => {
  const t = w.tags ?? {};
  // two-wheelers: banned when tagged "no"; motorways without a tag are treated as banned (Indian rule)
  const mc = t.motorcycle ?? (t.highway?.startsWith('motorway') ? 'default-no' : 'unknown');
  return {
    type: 'Feature',
    properties: { n: t.name ?? t.ref ?? '', r: t.ref ?? '', h: t.highway, mc },
    geometry: { type: 'LineString', coordinates: w.geometry.map((g) => [r5(g.lon), r5(g.lat)]) },
  };
}).filter((f) => f.properties.mc !== 'yes');
await writeFile(`${OUT}/expressways.json`, JSON.stringify({ type: 'FeatureCollection', generated: new Date().toISOString(), source: '© OpenStreetMap contributors (ODbL)', features }));

// ---- states: Natural Earth admin-1 (10m), India only, simplified with mapshaper
execSync('curl -sSL -o /tmp/ne.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson', { stdio: 'inherit' });
const ne = JSON.parse(await readFile('/tmp/ne.geojson', 'utf8'));
const india = {
  type: 'FeatureCollection',
  features: ne.features.filter((f) => f.properties.adm0_a3 === 'IND')
    .map((f) => ({ type: 'Feature', properties: { name: f.properties.name, code: f.properties.iso_3166_2 }, geometry: f.geometry })),
};
await writeFile('/tmp/india-raw.geojson', JSON.stringify(india));
execSync(`npx --yes mapshaper@0.6.102 /tmp/india-raw.geojson -simplify 4% keep-shapes -o precision=0.0001 format=geojson ${OUT}/india-states.json`, { stdio: 'inherit' });

const kb = async (f) => Math.round((await readFile(f)).length / 1024);
const states = JSON.parse(await readFile(`${OUT}/india-states.json`, 'utf8'));
const lenKm = (c) => { let d = 0; for (let i = 1; i < c.length; i++) d += Math.hypot((c[i][0] - c[i - 1][0]) * 108, (c[i][1] - c[i - 1][1]) * 111); return d; };
const summary = {
  generated: new Date().toISOString(),
  expressways: {
    ways: features.length,
    km: Math.round(features.reduce((a, f) => a + lenKm(f.geometry.coordinates), 0)),
    byAccess: features.reduce((a, f) => ((a[f.properties.mc] = (a[f.properties.mc] ?? 0) + 1), a), {}),
    expresswayNames: [...new Set(features.map((f) => f.properties.n).filter((n) => /expressway/i.test(n)))].slice(0, 80),
    kb: await kb(`${OUT}/expressways.json`),
  },
  states: { count: states.features.length, names: states.features.map((f) => f.properties.name).sort(), kb: await kb(`${OUT}/india-states.json`) },
};
await writeFile(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
