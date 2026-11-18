// Builds a compact on-device routing graph for one Geofabrik India zone.
//   node tools/build-graph.mjs southern-zone
// Output: graph-out/<zone>.rgg (binary, gzip-compressed by the workflow) + <zone>.json (stats)
//
// Roads: everything a motorcycle may legally use, EXCEPT motorways / expressways (banned for two-wheelers
// in India unless tagged motorcycle=yes), private/no-access roads, tracks, paths and service roads.
//
// Format v3 (written below): header + varint/zig-zag delta streams; see section 6. Older layout notes:
//   'RGG1' | u32 version | u32 V | u32 U (undirected edges) | u32 A (adjacency entries) | u32 S (shape points) | f64 bbox[4]
//   i32 lon[V]  i32 lat[V]                         (degrees * 1e6)
//   u32 adjStart[V+1]  u32 adjTo[A]  u32 adjEdge[A]  u8 adjFlag[A]   (flag 1: may go self→to, 2: may go to→self)
//   u32 edgeA[U]  u32 edgeB[U]  u32 len_dm[U]  u8 cls[U] (bit7 = one-way A→B)  u8 kmh[U]  u32 name[U]  u32 shapeStart[U+1]
//   i32 shape[2*S]                                 (intermediate points of each edge, from its first endpoint)
//   u32 namesBytes | names JSON (array of strings)
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import readline from 'node:readline';

const zone = process.argv[2] ?? 'southern-zone';
const OUT = 'graph-out';
await mkdir(OUT, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const CLASSES = ['trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'road', 'motorway', 'motorway_link'];
const KMH = { trunk: 70, trunk_link: 50, primary: 60, primary_link: 45, secondary: 50, secondary_link: 40, tertiary: 40, tertiary_link: 35, unclassified: 30, residential: 25, living_street: 15, road: 30, motorway: 80, motorway_link: 50 };

// ---- 1. download + filter with osmium, then dump as text (OPL)
const pbf = process.env.PBF ?? `/tmp/${zone}.osm.pbf`;   // PBF=... uses a local file (tests)
if (!process.env.PBF) execSync(`curl -fsSL --retry 6 --retry-delay 20 --retry-all-errors -o ${pbf} https://download.geofabrik.de/asia/india/${zone}-latest.osm.pbf`, { stdio: 'inherit' });
log('downloaded', execSync(`du -h ${pbf}`).toString().trim());
execSync(`osmium tags-filter ${pbf} w/highway=${CLASSES.join(',')} -o /tmp/roads.osm.pbf --overwrite`, { stdio: 'inherit' });
execSync(`osmium cat /tmp/roads.osm.pbf -f opl -o /tmp/roads.opl --overwrite`, { stdio: 'inherit' });
log('filtered', execSync('du -h /tmp/roads.opl').toString().trim());

// ---- 2. parse: nodes (sorted by id in the file) then ways
const unesc = (s) => s.replace(/%([0-9a-f]+)%/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
function tags(str) { const t = {}; if (!str) return t; for (const kv of str.split(',')) { const i = kv.indexOf('='); if (i > 0) t[unesc(kv.slice(0, i))] = unesc(kv.slice(i + 1)); } return t; }
let nodeCount = 0;
const nodeCountRl = readline.createInterface({ input: createReadStream('/tmp/roads.opl') });
for await (const line of nodeCountRl) { if (line.charCodeAt(0) === 110) nodeCount++; else if (line.charCodeAt(0) === 119) break; }
log('nodes', nodeCount);
const nid = new Float64Array(nodeCount), nlon = new Int32Array(nodeCount), nlat = new Int32Array(nodeCount);
const ways = []; // { refs: Uint32Array (node index), cls, kmh, oneway, name }
const names = new Map(); names.set('', 0);
const nameIdx = (n) => { let i = names.get(n); if (i === undefined) { i = names.size; names.set(n, i); } return i; };
const findNode = (id) => { let lo = 0, hi = nodeCount - 1; while (lo <= hi) { const m = (lo + hi) >>> 1; const v = nid[m]; if (v === id) return m; if (v < id) lo = m + 1; else hi = m - 1; } return -1; };
let ni = 0, skipped = { access: 0, motorway: 0 }; // motorway = kept but flagged two-wheeler-banned
const rl = readline.createInterface({ input: createReadStream('/tmp/roads.opl') });
for await (const line of rl) {
  const c = line.charCodeAt(0);
  if (c === 110) { // n
    const f = line.split(' ');
    nid[ni] = +f[0].slice(1);
    for (const x of f) { if (x[0] === 'x') nlon[ni] = Math.round(+x.slice(1) * 1e6); else if (x[0] === 'y') nlat[ni] = Math.round(+x.slice(1) * 1e6); }
    ni++;
  } else if (c === 119) { // w
    const ti = line.indexOf(' T'), nI = line.indexOf(' N');
    const t = tags(line.slice(ti + 2, nI));
    const hw = t.highway;
    if (!KMH[hw]) continue;
    if (process.argv[3] === 'main' && (hw === 'residential' || hw === 'living_street')) continue; // main-roads tier
    // closed to all motor traffic / private → left out. Closed to two-wheelers only (expressways,
    // motorcycle=no) → kept but flagged, so daily rides may use them and the expedition never does.
    const mv = t.motor_vehicle ?? t.vehicle ?? t.access;
    if (t.motorcycle !== 'yes' && (mv === 'no' || mv === 'private' || t.access === 'no' || t.access === 'private')) { skipped.access++; continue; }
    const banned = t.motorcycle === 'no' || (hw.startsWith('motorway') && t.motorcycle !== 'yes');
    if (banned) skipped.motorway++;
    if (t.area === 'yes') continue;
    const refs = line.slice(nI + 2).split(',').map((r) => findNode(+r.slice(1))).filter((x) => x >= 0);
    if (refs.length < 2) continue;
    const ow = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout' || t.junction === 'circular' ? 1 : t.oneway === '-1' ? -1 : 0;
    const max = parseInt(t.maxspeed ?? '', 10);
    const kmh = Math.min(KMH[hw], Number.isFinite(max) && max > 5 ? max : 999);
    const label = [t.ref, t.name].filter(Boolean).join(' · ');
    ways.push({ refs: Uint32Array.from(ow === -1 ? refs.reverse() : refs), cls: CLASSES.indexOf(hw) | (banned ? 0x40 : 0), kmh, oneway: ow !== 0, name: nameIdx(label) });
  }
}
log('ways', ways.length, 'skipped', skipped);

// ---- 3. vertices = way endpoints + nodes shared by 2+ ways
const use = new Uint8Array(nodeCount);
for (const w of ways) { for (const r of w.refs) if (use[r] < 2) use[r]++; use[w.refs[0]] = 2; use[w.refs[w.refs.length - 1]] = 2; }
const vOf = new Int32Array(nodeCount).fill(-1);
let V = 0;
for (let i = 0; i < nodeCount; i++) if (use[i] >= 2) vOf[i] = V++;
log('vertices', V);

// ---- 4. split ways into edges between vertices
const R = 6371008.8, RAD = Math.PI / 180;
const dist = (a, b) => { const la1 = nlat[a] / 1e6 * RAD, la2 = nlat[b] / 1e6 * RAD, dl = (nlon[b] - nlon[a]) / 1e6 * RAD;
  const x = Math.sin((la2 - la1) / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dl / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
// simplify each edge's shape to ~2 m (Douglas–Peucker) — invisible on a phone, ~40% fewer points
const simplify = (pts, tolM = 2) => {
  if (pts.length <= 2) return pts;
  const kx = Math.cos((pts[0][1] / 1e6) * RAD) * R * RAD / 1e6, ky = R * RAD / 1e6;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const ax = pts[a][0] * kx, ay = pts[a][1] * ky, bx = pts[b][0] * kx, by = pts[b][1] * ky, dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] * kx, py = pts[i][1] * ky;
      const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tolM) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
};
const eFrom = [], eTo = [], eLen = [], eCls = [], eKmh = [], eName = [], shapeStart = [0], shape = [];
for (const w of ways) {
  let start = 0, len = 0;
  for (let k = 1; k < w.refs.length; k++) {
    len += dist(w.refs[k - 1], w.refs[k]);
    if (vOf[w.refs[k]] >= 0) {
      const a = vOf[w.refs[start]], b = vOf[w.refs[k]];
      if (a !== b || k - start > 1) {
        eFrom.push(a); eTo.push(b); eLen.push(Math.max(1, Math.round(len * 10))); eCls.push(w.cls | (w.oneway ? 0x80 : 0)); eKmh.push(w.kmh); eName.push(w.name);
        const pts = []; for (let j = start; j <= k; j++) pts.push([nlon[w.refs[j]], nlat[w.refs[j]]]);
        const simp = simplify(pts);
        for (let j = 1; j < simp.length - 1; j++) shape.push(simp[j][0], simp[j][1]);
        shapeStart.push(shape.length / 2);
      }
      start = k; len = 0;
    }
  }
}
const U = eFrom.length;
log('edges', U, 'shape points (simplified)', shape.length / 2);

// ---- 5. vertex coordinates, then renumber vertices along a Morton (Z-order) curve so neighbours get
//         nearby numbers — that makes the delta-encoded file much smaller
const vlon0 = new Int32Array(V), vlat0 = new Int32Array(V);
let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
for (let i = 0; i < nodeCount; i++) { const v = vOf[i]; if (v < 0) continue; vlon0[v] = nlon[i]; vlat0[v] = nlat[i];
  minX = Math.min(minX, nlon[i]); maxX = Math.max(maxX, nlon[i]); minY = Math.min(minY, nlat[i]); maxY = Math.max(maxY, nlat[i]); }
const morton = (x, y) => { let k = 0; for (let b = 19; b >= 0; b--) k = k * 4 + ((y >> b) & 1) * 2 + ((x >> b) & 1); return k; };
const keys = new Float64Array(V);
for (let v = 0; v < V; v++) keys[v] = morton(Math.floor((vlon0[v] - minX) / 50), Math.floor((vlat0[v] - minY) / 50)); // ~5 m cells
const order = Uint32Array.from({ length: V }, (_, i) => i).sort((a, b) => keys[a] - keys[b]);
const newId = new Uint32Array(V); order.forEach((old, n) => { newId[old] = n; });
const eOrder = Uint32Array.from({ length: U }, (_, i) => i).sort((x, y) => (newId[eFrom[x]] - newId[eFrom[y]]) || (newId[eTo[x]] - newId[eTo[y]]));

// ---- 6. write format v3: varint / zig-zag delta streams (adjacency is rebuilt on the device)
const tier = process.argv[3] === 'main' ? 'main' : 'full';
let buf = Buffer.alloc(64 << 20), n = 0;
const need = (k) => { if (n + k > buf.length) { const nb = Buffer.alloc(buf.length * 2); buf.copy(nb, 0, 0, n); buf = nb; } };
const u = (v) => { need(10); while (v >= 0x80) { buf[n++] = (v % 0x80) | 0x80; v = Math.floor(v / 0x80); } buf[n++] = v; };
const z = (v) => u(v < 0 ? -2 * v - 1 : 2 * v);
const namesJson = Buffer.from(JSON.stringify([...names.keys()]));
const S = shape.length / 2;
need(64); buf.write('RGG1', 0); buf.writeUInt32LE(3, 4); buf.writeUInt32LE(V, 8); buf.writeUInt32LE(U, 12); buf.writeUInt32LE(S, 16); buf.writeUInt32LE((tier === 'main' ? 1 : 0) | 2, 20); // bit 1: main tier, bit 2: banned roads included (flag 0x40)
[minX / 1e6, minY / 1e6, maxX / 1e6, maxY / 1e6].forEach((x, i) => buf.writeDoubleLE(x, 24 + i * 8));
n = 56;
let px = 0, py = 0;
for (const old of order) { z(vlon0[old] - px); z(vlat0[old] - py); px = vlon0[old]; py = vlat0[old]; }
let pa = 0;
for (const e of eOrder) {
  const a = newId[eFrom[e]], b = newId[eTo[e]];
  u(a - pa); z(b - a); pa = a;
  u(eLen[e]); u(eCls[e]); u(eKmh[e]); u(eName[e]);
  const s0 = shapeStart[e], s1 = shapeStart[e + 1];
  u(s1 - s0);
  let qx = vlon0[eFrom[e]], qy = vlat0[eFrom[e]];
  for (let s = s0; s < s1; s++) { z(shape[2 * s] - qx); z(shape[2 * s + 1] - qy); qx = shape[2 * s]; qy = shape[2 * s + 1]; }
}
need(4 + namesJson.length); buf.writeUInt32LE(namesJson.length, n); n += 4; namesJson.copy(buf, n); n += namesJson.length;
const file = buf.subarray(0, n);
const name = tier === 'main' ? `${zone}-main` : zone;
await writeFile(`${OUT}/${name}.rgg`, file);
const km = eLen.reduce((a, b) => a + b, 0) / 10000;
const stats = { zone, tier, generated: new Date().toISOString(), nodes: nodeCount, ways: ways.length, skipped, vertices: V, edges: U, shapePoints: S, names: names.size, km: Math.round(km), bytes: file.length, bbox: [minX / 1e6, minY / 1e6, maxX / 1e6, maxY / 1e6], seconds: Math.round((Date.now() - t0) / 1000) };
await writeFile(`${OUT}/${name}.json`, JSON.stringify(stats, null, 1));
log(JSON.stringify(stats));
