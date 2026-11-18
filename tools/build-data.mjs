// Builds the India data files used by the app (run by .github/workflows/data.yml, output in ./data-out):
//   expressways.json  – motorways / expressways from OpenStreetMap with two-wheeler access
//   india-states.json – state & UT boundaries (Natural Earth admin-1, public domain), simplified
//   summary.json      – counts and sizes for a quick check
// The workflow publishes them as assets of the "india-data" release; the site build downloads them.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const OUT = 'data-out';
await mkdir(OUT, { recursive: true });
const r5 = (x) => Math.round(x * 1e5) / 1e5;

// ---- expressways: from the Geofabrik India extract, filtered locally with osmium (no query server needed)
const PBF = '/tmp/india.osm.pbf';
execSync(`curl -sSL --retry 3 -o ${PBF} https://download.geofabrik.de/asia/india-latest.osm.pbf`, { stdio: 'inherit' });
execSync(`osmium tags-filter ${PBF} w/highway=motorway,motorway_link w/motorcycle=no -o /tmp/roads.osm.pbf --overwrite`, { stdio: 'inherit' });
execSync(`osmium export /tmp/roads.osm.pbf -f geojsonseq --geometry-types=linestring -o /tmp/roads.geojsonseq --overwrite`, { stdio: 'inherit' });
const NOT_ROADS = /^(footway|path|cycleway|pedestrian|steps|track|service|bridleway|corridor|platform|construction|proposed)$/;
const features = [];
for (const line of (await readFile('/tmp/roads.geojsonseq', 'utf8')).split('\n')) {
  const txt = line.replace(/^\x1e/, '').trim();
  if (!txt) continue;
  const f = JSON.parse(txt);
  const t = f.properties ?? {};
  if (!t.highway || NOT_ROADS.test(t.highway)) continue;
  // two-wheelers: banned when tagged "no"; untagged motorways are treated as banned (Indian rule); "yes" is allowed
  const mc = t.motorcycle ?? (t.highway.startsWith('motorway') ? 'default-no' : 'unknown');
  if (mc === 'yes' || mc === 'unknown') continue;
  features.push({ type: 'Feature', properties: { n: t.name ?? t.ref ?? '', r: t.ref ?? '', h: t.highway, mc },
    geometry: { type: 'LineString', coordinates: f.geometry.coordinates.map(([x, y]) => [r5(x), r5(y)]) } });
}
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
