/**
 * On-device road graph (format written by tools/build-graph.mjs) + A* routing.
 * Pure TypeScript, no DOM: runs inside a Web Worker in the app and directly in tests.
 */
export type LngLat = [number, number];
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
  private _work: { dist: Float64Array; prevE: Int32Array; prevV: Int32Array; done: Uint8Array } | null = null;
  /** Search arrays sized to the graph, allocated once and reused (callers reset what they touch). */
  work() {
    if (!this._work) { const d = new Float64Array(this.V); d.fill(Infinity); this._work = { dist: d, prevE: new Int32Array(this.V), prevV: new Int32Array(this.V), done: new Uint8Array(this.V) }; }
    return this._work;
  }
  private static CELL = 0.005;

  constructor(buf: ArrayBuffer) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'RGG1' || dv.getUint32(4, true) !== 2) throw new Error('Not a RideGrid road graph (v2)');
    this.V = dv.getUint32(8, true); this.U = dv.getUint32(12, true); this.A = dv.getUint32(16, true); this.S = dv.getUint32(20, true);
    this.bbox = [dv.getFloat64(24, true), dv.getFloat64(32, true), dv.getFloat64(40, true), dv.getFloat64(48, true)];
    let o = 56;
    const take = <T>(C: { new (b: ArrayBuffer, o: number, n: number): T; BYTES_PER_ELEMENT: number }, n: number): T => {
      const a = new C(buf, o, n); o += (n * C.BYTES_PER_ELEMENT + 3) & ~3; return a;
    };
    const { V, U, A, S } = this;
    this.lon = take(Int32Array, V); this.lat = take(Int32Array, V);
    this.adjStart = take(Uint32Array, V + 1); this.adjTo = take(Uint32Array, A); this.adjEdge = take(Uint32Array, A); this.adjFlag = take(Uint8Array, A);
    this.ea = take(Uint32Array, U); this.eb = take(Uint32Array, U);
    this.len = take(Uint32Array, U); this.cls = take(Uint8Array, U); this.kmh = take(Uint8Array, U); this.name = take(Uint32Array, U);
    this.shapeStart = take(Uint32Array, U + 1); this.shape = take(Int32Array, 2 * S);
    const nb = dv.getUint32(o, true);
    this.names = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, o + 4, nb)));
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

/** Shortest-time route between two points with A* (snaps both points to the nearest road first). */
export function route(g: Graph, from: LngLat, to: LngLat): Path | null {
  const a = g.snap(from), b = g.snap(to);
  if (!a || !b) return null;
  const sec = (e: number, m: number) => m / (g.kmh[e] / 3.6);
  const edgeM = (e: number) => g.len[e] / 10;
  const oneway = (e: number) => (g.cls[e] & 0x80) !== 0;
  // reusable per-graph search arrays (reset only what was touched) — fast even with millions of junctions
  const W = g.work();
  const { dist, prevE, prevV, done } = W;
  const touched: number[] = [];
  const getD = (v: number) => dist[v];
  const setD = (v: number, d: number, e: number, pv: number) => { if (dist[v] === Infinity) touched.push(v); dist[v] = d; prevE[v] = e; prevV[v] = pv; };
  const h = (v: number) => { const x = (g.lon[v] / 1e6 - to[0]) * Math.cos(to[1] * RAD) * 111320, y = (g.lat[v] / 1e6 - to[1]) * 110540; return Math.hypot(x, y) / (75 / 3.6); };
  const heap = new Heap();
  // start: leave the snapped point towards either end of its edge (respecting one-way)
  const startTo = (v: number, cost: number) => { if (cost < getD(v)) { setD(v, cost, -1, -1); heap.push(cost + h(v), v); } };
  startTo(g.eb[a.e], sec(a.e, edgeM(a.e) - a.along));
  if (!oneway(a.e)) startTo(g.ea[a.e], sec(a.e, a.along));
  // goal: arrive at either end of b's edge and travel along it to the snapped point
  const goalCost = (v: number) => (v === g.ea[b.e] ? sec(b.e, b.along) : v === g.eb[b.e] && !oneway(b.e) ? sec(b.e, edgeM(b.e) - b.along) : Infinity);
  let bestTotal = Infinity, bestEnd = -1;
  // same edge, direct
  if (a.e === b.e && (b.along >= a.along || !oneway(a.e))) { bestTotal = sec(a.e, Math.abs(b.along - a.along)); bestEnd = -2; }
  let settled = 0;
  try {
    while (heap.size) {
      if (heap.peekKey() >= bestTotal) break;
      const v = heap.pop();
      if (done[v]) continue;
      done[v] = 1; settled++;
      const dv = dist[v];
      const gc = goalCost(v);
      if (dv + gc < bestTotal) { bestTotal = dv + gc; bestEnd = v; }
      for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
        if (!(g.adjFlag[i] & 1)) continue;
        const e = g.adjEdge[i], w = g.adjTo[i];
        const nd = dv + sec(e, edgeM(e));
        if (nd < dist[w]) { setD(w, nd, e, v); heap.push(nd + h(w), w); }
      }
      if (settled > 4_000_000) break;
    }
  } catch (e) { for (const v of touched) { dist[v] = Infinity; done[v] = 0; } throw e; }
  const prevEdge = { get: (v: number) => prevE[v] }, prevVx = { get: (v: number) => prevV[v] };
  const cleanup = () => { for (const v of touched) { dist[v] = Infinity; done[v] = 0; } };
  if (bestEnd === -1) { cleanup(); return null; }
  // ---- rebuild geometry
  const coords: LngLat[] = [], names: (string | undefined)[] = [];
  const add = (pts: LngLat[], name: string | undefined) => { for (const p of pts) { const l = coords[coords.length - 1]; if (l && l[0] === p[0] && l[1] === p[1]) continue; coords.push(p); names.push(name); } };
  const cut = (e: number, fromM: number, toM: number): LngLat[] => {
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
  const nameOf = (e: number) => g.names[g.name[e]] || undefined;
  if (bestEnd === -2) {
    add(cut(a.e, a.along, b.along), nameOf(a.e));
  } else {
    const chain: number[] = [];
    for (let v = bestEnd; v !== -1 && prevEdge.get(v) !== -1; v = prevVx.get(v)) chain.push(v);
    const startV = chain.length ? prevVx.get(chain[chain.length - 1]) : bestEnd;
    // first partial edge: from snap point a to startV
    add(cut(a.e, a.along, startV === g.ea[a.e] ? 0 : edgeM(a.e)), nameOf(a.e));
    for (let k = chain.length - 1; k >= 0; k--) {
      const v = chain[k], e = prevEdge.get(v);
      const pts = g.edgeCoords(e);
      add(g.ea[e] === v ? pts.reverse() : pts, nameOf(e));
    }
    // last partial edge: from bestEnd to snap point b
    add(cut(b.e, bestEnd === g.ea[b.e] ? 0 : edgeM(b.e), b.along), nameOf(b.e));
  }
  cleanup();
  let distM = 0;
  for (let i = 1; i < coords.length; i++) distM += Math.hypot((coords[i][0] - coords[i - 1][0]) * Math.cos(coords[i][1] * RAD) * 111320, (coords[i][1] - coords[i - 1][1]) * 110540);
  return { coords, distM, timeS: bestTotal, names, settled };
}
