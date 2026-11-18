/**
 * On-device road graph (format written by tools/build-graph.mjs) + A* routing.
 * Pure TypeScript, no DOM: runs inside a Web Worker in the app and directly in tests.
 */
export type LngLat = [number, number];
export interface Link { g: Graph; v: number }
const RAD = Math.PI / 180, R = 6371008.8;

export class Graph {
  V: number; U: number; A: number; S: number;
  bbox: [number, number, number, number];
  lon: Int32Array; lat: Int32Array;
  adjStart: Uint32Array; adjTo: Uint32Array; adjEdge: Uint32Array; adjFlag: Uint8Array;
  len: Uint32Array; cls: Uint8Array; kmh: Uint8Array; name: Uint32Array; shapeStart: Uint32Array; shape: Int32Array;
  names: string[];
  /** first/second endpoint of each edge */
  ea: Uint32Array; eb: Uint32Array;
  private grid = new Map<number, number[]>();
  /** junctions this graph shares (same OSM node, same coordinates) with neighbouring region graphs */
  links = new Map<number, Link[]>();
  private _work: { dist: Float64Array; prevE: Int32Array; prevV: Int32Array; done: Uint8Array } | null = null;
  /** Search arrays sized to the graph, allocated once and reused (callers reset what they touch). */
  work() {
    if (!this._work) { const d = new Float64Array(this.V); d.fill(Infinity); this._work = { dist: d, prevE: new Int32Array(this.V), prevV: new Int32Array(this.V), done: new Uint8Array(this.V) }; }
    return this._work;
  }
  private static CELL = 0.005;

  tier: 'main' | 'full';
  constructor(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'RGG1' || dv.getUint32(4, true) !== 3) throw new Error('Not a RideGrid road graph (v3)');
    const V = (this.V = dv.getUint32(8, true)), U = (this.U = dv.getUint32(12, true)), S = (this.S = dv.getUint32(16, true));
    this.tier = dv.getUint32(20, true) === 1 ? 'main' : 'full';
    this.bbox = [dv.getFloat64(24, true), dv.getFloat64(32, true), dv.getFloat64(40, true), dv.getFloat64(48, true)];
    const b = new Uint8Array(buf);
    let o = 56;
    const u = () => { let v = 0, m = 1, c; do { c = b[o++]; v += (c & 0x7f) * m; m *= 128; } while (c & 0x80); return v; };
    const z = () => { const v = u(); return v % 2 ? -(v + 1) / 2 : v / 2; };
    this.lon = new Int32Array(V); this.lat = new Int32Array(V);
    let x = 0, y = 0;
    for (let v = 0; v < V; v++) { x += z(); y += z(); this.lon[v] = x; this.lat[v] = y; }
    this.ea = new Uint32Array(U); this.eb = new Uint32Array(U); this.len = new Uint32Array(U); this.cls = new Uint8Array(U); this.kmh = new Uint8Array(U);
    this.name = new Uint32Array(U); this.shapeStart = new Uint32Array(U + 1); this.shape = new Int32Array(2 * S);
    let a = 0, sp = 0;
    for (let e = 0; e < U; e++) {
      a += u(); const bb = a + z();
      this.ea[e] = a; this.eb[e] = bb;
      this.len[e] = u(); this.cls[e] = u(); this.kmh[e] = u(); this.name[e] = u();
      const k = u();
      let qx = this.lon[a], qy = this.lat[a];
      for (let i = 0; i < k; i++) { qx += z(); qy += z(); this.shape[2 * sp] = qx; this.shape[2 * sp + 1] = qy; sp++; }
      this.shapeStart[e + 1] = sp;
    }
    const nb = new DataView(buf, o, 4).getUint32(0, true);
    this.names = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o + 4, nb)));
    // adjacency (both endpoints, direction flags) rebuilt here instead of being downloaded
    const deg = new Uint32Array(V + 1);
    for (let e = 0; e < U; e++) { deg[this.ea[e]]++; deg[this.eb[e]]++; }
    this.adjStart = new Uint32Array(V + 1);
    for (let v = 0; v < V; v++) this.adjStart[v + 1] = this.adjStart[v] + deg[v];
    const A = (this.A = this.adjStart[V]);
    this.adjTo = new Uint32Array(A); this.adjEdge = new Uint32Array(A); this.adjFlag = new Uint8Array(A);
    const fill = this.adjStart.slice(0, V);
    for (let e = 0; e < U; e++) {
      const one = (this.cls[e] & 0x80) !== 0, p = this.ea[e], q = this.eb[e];
      let i = fill[p]++; this.adjTo[i] = q; this.adjEdge[i] = e; this.adjFlag[i] = one ? 1 : 3;
      i = fill[q]++; this.adjTo[i] = p; this.adjEdge[i] = e; this.adjFlag[i] = one ? 2 : 3;
    }
    this.buildGrid();
  }

  /** Full geometry of edge e from ea to eb, in degrees. */
  edgeCoords(e: number): LngLat[] {
    const out: LngLat[] = [[this.lon[this.ea[e]] / 1e6, this.lat[this.ea[e]] / 1e6]];
    for (let s = this.shapeStart[e]; s < this.shapeStart[e + 1]; s++) out.push([this.shape[2 * s] / 1e6, this.shape[2 * s + 1] / 1e6]);
    out.push([this.lon[this.eb[e]] / 1e6, this.lat[this.eb[e]] / 1e6]);
    return out;
  }

  private buildGrid() {
    const C = Graph.CELL;
    for (let e = 0; e < this.U; e++) {
      let x0 = Math.min(this.lon[this.ea[e]], this.lon[this.eb[e]]), x1 = Math.max(this.lon[this.ea[e]], this.lon[this.eb[e]]);
      let y0 = Math.min(this.lat[this.ea[e]], this.lat[this.eb[e]]), y1 = Math.max(this.lat[this.ea[e]], this.lat[this.eb[e]]);
      for (let s = this.shapeStart[e]; s < this.shapeStart[e + 1]; s++) {
        x0 = Math.min(x0, this.shape[2 * s]); x1 = Math.max(x1, this.shape[2 * s]); y0 = Math.min(y0, this.shape[2 * s + 1]); y1 = Math.max(y1, this.shape[2 * s + 1]);
      }
      const cx0 = Math.floor(x0 / 1e6 / C), cx1 = Math.floor(x1 / 1e6 / C), cy0 = Math.floor(y0 / 1e6 / C), cy1 = Math.floor(y1 / 1e6 / C);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 400) continue;
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
        const k = (cx + 100000) * 200000 + (cy + 100000);
        const a = this.grid.get(k); if (a) a.push(e); else this.grid.set(k, [e]);
      }
    }
  }

  contains(p: LngLat) { const b = this.bbox; return p[0] >= b[0] - 0.05 && p[0] <= b[2] + 0.05 && p[1] >= b[1] - 0.05 && p[1] <= b[3] + 0.05; }

  /** Nearest point on any road: edge, distance from the point, and position along the edge (metres from ea). */
  snap(p: LngLat, maxM = 2000): { e: number; d: number; along: number; p: LngLat } | null {
    const C = Graph.CELL;
    const kx = Math.cos(p[1] * RAD) * R * RAD, ky = R * RAD;
    type Snap = { e: number; d: number; along: number; p: LngLat };
    let best = null as Snap | null;
    for (let ring = 0; ring <= Math.ceil(maxM / (C * ky)) + 1; ring++) {
      const cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C);
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const list = this.grid.get((cx + dx + 100000) * 200000 + (cy + dy + 100000));
        if (!list) continue;
        for (const e of list) {
          const pts = this.edgeCoords(e);
          let acc = 0;
          for (let i = 0; i < pts.length - 1; i++) {
            const ax = (pts[i][0] - p[0]) * kx, ay = (pts[i][1] - p[1]) * ky, bx = (pts[i + 1][0] - p[0]) * kx, by = (pts[i + 1][1] - p[1]) * ky;
            const ddx = bx - ax, ddy = by - ay, L = ddx * ddx + ddy * ddy, segLen = Math.sqrt(L);
            const t = L ? Math.max(0, Math.min(1, -(ax * ddx + ay * ddy) / L)) : 0;
            const d = Math.hypot(ax + t * ddx, ay + t * ddy);
            if (d <= maxM && (!best || d < best.d)) best = { e, d, along: acc + t * segLen, p: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t] };
            acc += segLen;
          }
        }
      }
      // once something is found, one more ring is enough (cells are larger than any closer miss)
      const found = best as Snap | null;
      if (found && ring * C * ky > found.d + C * ky) break;
    }
    return best;
  }
}

/** Binary min-heap of (key, value). */
class Heap {
  k: number[] = []; v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v, top = v[0], lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  peekKey() { return this.k[0]; }
}

export interface Path { coords: LngLat[]; distM: number; timeS: number; names: (string | undefined)[]; settled: number }

/**
 * Join two neighbouring region graphs at their shared junctions (the same OSM nodes appear in both
 * extracts along the border). Returns the number of shared junctions.
 */
export function linkGraphs(a: Graph, b: Graph): number {
  const ov = [Math.max(a.bbox[0], b.bbox[0]), Math.max(a.bbox[1], b.bbox[1]), Math.min(a.bbox[2], b.bbox[2]), Math.min(a.bbox[3], b.bbox[3])].map((v) => Math.round(v * 1e6));
  if (ov[0] > ov[2] || ov[1] > ov[3]) return 0;
  const key = (x: number, y: number) => (x + 180e6) * 4e8 + (y + 100e6);
  const inOv = (g: Graph, v: number) => g.lon[v] >= ov[0] && g.lon[v] <= ov[2] && g.lat[v] >= ov[1] && g.lat[v] <= ov[3];
  const keys = (g: Graph) => {
    let n = 0;
    for (let v = 0; v < g.V; v++) if (inOv(g, v)) n++;
    const k = new Float64Array(n); n = 0;
    for (let v = 0; v < g.V; v++) if (inOv(g, v)) k[n++] = key(g.lon[v], g.lat[v]);
    return k.sort();
  };
  const ka = keys(a), kb = keys(b), shared = new Set<number>();
  for (let i = 0, j = 0; i < ka.length && j < kb.length;) {
    if (ka[i] === kb[j]) { shared.add(ka[i]); i++; j++; } else if (ka[i] < kb[j]) i++; else j++;
  }
  if (!shared.size) return 0;
  const ids = (g: Graph) => { const m = new Map<number, number>(); for (let v = 0; v < g.V; v++) if (inOv(g, v)) { const k = key(g.lon[v], g.lat[v]); if (shared.has(k) && !m.has(k)) m.set(k, v); } return m; };
  const ia = ids(a), ib = ids(b);
  const add = (g: Graph, v: number, l: Link) => { const x = g.links.get(v); if (x) x.push(l); else g.links.set(v, [l]); };
  let n = 0;
  for (const [k, va] of ia) { const vb = ib.get(k); if (vb === undefined) continue; add(a, va, { g: b, v: vb }); add(b, vb, { g: a, v: va }); n++; }
  return n;
}

/** Forget every link into graph `gone` (when a region is removed). */
export function unlinkGraph(gone: Graph, others: Iterable<Graph>) {
  for (const g of others) for (const [v, ls] of g.links) {
    const keep = ls.filter((l) => l.g !== gone);
    if (!keep.length) g.links.delete(v); else if (keep.length !== ls.length) g.links.set(v, keep);
  }
  gone.links.clear();
}

/** Shortest-time route between two points with A* in one graph. */
export function route(g: Graph, from: LngLat, to: LngLat): Path | null { return routeMulti([g], from, to); }

/**
 * Shortest-time route with A* across one or more region graphs: the search hops between regions
 * at their shared border junctions, so a ride from one downloaded region into the next works offline.
 */
export function routeMulti(gs: Graph[], from: LngLat, to: LngLat): Path | null {
  const snapBest = (p: LngLat) => {
    let best: { gi: number; s: NonNullable<ReturnType<Graph['snap']>> } | null = null;
    gs.forEach((g, gi) => { if (!g.contains(p)) return; const s = g.snap(p, 500); if (s && (!best || s.d < best.s.d)) best = { gi, s }; });
    return best as { gi: number; s: NonNullable<ReturnType<Graph['snap']>> } | null;
  };
  const A = snapBest(from), B = snapBest(to);
  if (!A || !B) return null;
  const ga = gs[A.gi], gb = gs[B.gi], a = A.s, b = B.s;
  const base: number[] = [0];
  for (const g of gs) base.push(base[base.length - 1] + g.V);
  const dec = (id: number) => { let i = 0; while (id >= base[i + 1]) i++; return i; };
  const W = gs.map((g) => g.work());
  const sec = (g: Graph, e: number, m: number) => m / (g.kmh[e] / 3.6);
  const edgeM = (g: Graph, e: number) => g.len[e] / 10;
  const oneway = (g: Graph, e: number) => (g.cls[e] & 0x80) !== 0;
  const touched: number[] = [];
  const setD = (gi: number, v: number, d: number, e: number, pv: number) => {
    const w = W[gi]; if (w.dist[v] === Infinity) touched.push(base[gi] + v);
    w.dist[v] = d; w.prevE[v] = e; w.prevV[v] = pv;
  };
  const kx = Math.cos(to[1] * RAD) * 111320;
  const h = (g: Graph, v: number) => Math.hypot((g.lon[v] / 1e6 - to[0]) * kx, (g.lat[v] / 1e6 - to[1]) * 110540) / (75 / 3.6);
  const heap = new Heap();
  const startTo = (v: number, cost: number) => { if (cost < W[A.gi].dist[v]) { setD(A.gi, v, cost, -1, -1); heap.push(cost + h(ga, v), base[A.gi] + v); } };
  startTo(ga.eb[a.e], sec(ga, a.e, edgeM(ga, a.e) - a.along));
  if (!oneway(ga, a.e)) startTo(ga.ea[a.e], sec(ga, a.e, a.along));
  const goalCost = (gi: number, v: number) => gi !== B.gi ? Infinity
    : v === gb.ea[b.e] ? sec(gb, b.e, b.along) : v === gb.eb[b.e] && !oneway(gb, b.e) ? sec(gb, b.e, edgeM(gb, b.e) - b.along) : Infinity;
  let bestTotal = Infinity, bestEnd = -1;
  if (A.gi === B.gi && a.e === b.e && (b.along >= a.along || !oneway(ga, a.e))) { bestTotal = sec(ga, a.e, Math.abs(b.along - a.along)); bestEnd = -2; }
  let settled = 0;
  const cleanup = () => { for (const id of touched) { const gi = dec(id), v = id - base[gi]; W[gi].dist[v] = Infinity; W[gi].done[v] = 0; } };
  try {
    while (heap.size) {
      if (heap.peekKey() >= bestTotal) break;
      const id = heap.pop(), gi = dec(id), g = gs[gi], v = id - base[gi], w = W[gi];
      if (w.done[v]) continue;
      w.done[v] = 1; settled++;
      const dv = w.dist[v];
      const gc = goalCost(gi, v);
      if (dv + gc < bestTotal) { bestTotal = dv + gc; bestEnd = id; }
      for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
        if (!(g.adjFlag[i] & 1)) continue;
        const e = g.adjEdge[i], to2 = g.adjTo[i];
        const nd = dv + sec(g, e, edgeM(g, e));
        if (nd < w.dist[to2]) { setD(gi, to2, nd, e, id); heap.push(nd + h(g, to2), base[gi] + to2); }
      }
      // hop into a neighbouring region at a shared border junction (same place, no cost)
      const ls = g.links.get(v);
      if (ls) for (const l of ls) {
        const hi = gs.indexOf(l.g);
        if (hi < 0 || dv >= W[hi].dist[l.v]) continue;
        setD(hi, l.v, dv, -2, id); heap.push(dv + h(l.g, l.v), base[hi] + l.v);
      }
      if (settled > 4_000_000) break;
    }
  } catch (e) { cleanup(); throw e; }
  if (bestEnd === -1) { cleanup(); return null; }
  // ---- rebuild geometry
  const coords: LngLat[] = [], names: (string | undefined)[] = [];
  const add = (pts: LngLat[], name: string | undefined) => { for (const p of pts) { const l = coords[coords.length - 1]; if (l && l[0] === p[0] && l[1] === p[1]) continue; coords.push(p); names.push(name); } };
  const cut = (g: Graph, e: number, fromM: number, toM: number): LngLat[] => {
    // part of edge e between two distances from ea (either order)
    const pts = g.edgeCoords(e), rev = toM < fromM, lo = Math.min(fromM, toM), hi = Math.max(fromM, toM);
    const out: LngLat[] = []; let acc = 0;
    const at = (i: number, t: number): LngLat => [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
    for (let i = 0; i < pts.length - 1; i++) {
      const s = Math.hypot((pts[i + 1][0] - pts[i][0]) * Math.cos(pts[i][1] * RAD) * 111320, (pts[i + 1][1] - pts[i][1]) * 110540);
      if (acc + s >= lo && acc <= hi) {
        if (!out.length) out.push(at(i, s ? Math.max(0, (lo - acc) / s) : 0));
        if (acc + s <= hi) out.push(pts[i + 1]); else out.push(at(i, s ? (hi - acc) / s : 0));
      }
      acc += s;
    }
    return rev ? out.reverse() : out;
  };
  const nameOf = (g: Graph, e: number) => g.names[g.name[e]] || undefined;
  if (bestEnd === -2) {
    add(cut(ga, a.e, a.along, b.along), nameOf(ga, a.e));
  } else {
    const chain: number[] = [];
    let cur = bestEnd;
    for (;;) { const gi = dec(cur), v = cur - base[gi]; if (W[gi].prevE[v] === -1) break; chain.push(cur); cur = W[gi].prevV[v]; }
    const startV = cur - base[A.gi];
    add(cut(ga, a.e, a.along, startV === ga.ea[a.e] ? 0 : edgeM(ga, a.e)), nameOf(ga, a.e));
    for (let k = chain.length - 1; k >= 0; k--) {
      const gi = dec(chain[k]), g = gs[gi], v = chain[k] - base[gi], e = W[gi].prevE[v];
      if (e === -2) continue; // border hop: same point in the next region
      const pts = g.edgeCoords(e);
      add(g.ea[e] === v ? pts.reverse() : pts, nameOf(g, e));
    }
    const endV = bestEnd - base[B.gi];
    add(cut(gb, b.e, endV === gb.ea[b.e] ? 0 : edgeM(gb, b.e), b.along), nameOf(gb, b.e));
  }
  cleanup();
  let distM = 0;
  for (let i = 1; i < coords.length; i++) distM += Math.hypot((coords[i][0] - coords[i - 1][0]) * Math.cos(coords[i][1] * RAD) * 111320, (coords[i][1] - coords[i - 1][1]) * 110540);
  return { coords, distM, timeS: bestTotal, names, settled };
}
