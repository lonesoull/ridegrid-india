import { engine, type Leg } from '../core/engine';
import { haversine, type LngLat } from '../core/geo';
import type { Turn, TurnCode } from '../core/turns';

export interface LineTurn { s: number; c: TurnCode; n?: string; x?: number }
export interface Approach { coords: LngLat[]; turns?: Turn[] }

const RAD = Math.PI / 180;

/** The whole planned route as one continuous polyline with cumulative distances (metres). */
export interface RouteLine {
  x: Float64Array; y: Float64Array; cum: Float64Array; n: number;
  /** distance along the line at which stop i is reached */
  stopS: Float64Array;
  total: number;
  /** maneuvers along the line, sorted by distance */
  turns: LineTurn[];
}

export function buildRouteLine(): RouteLine {
  const S = engine.stops;
  const byPair = new Map<string, Leg>();
  for (const l of engine.legs.values()) byPair.set(`${l.a}>${l.b}`, l);
  const xs: number[] = [], ys: number[] = [], cum: number[] = [];
  const stopS = new Float64Array(S.length);
  const turns: LineTurn[] = [];
  let d = 0;
  const push = (p: LngLat) => {
    const n = xs.length;
    if (n && xs[n - 1] === p[0] && ys[n - 1] === p[1]) return;
    if (n) d += haversine([xs[n - 1], ys[n - 1]], p);
    xs.push(p[0]); ys.push(p[1]); cum.push(d);
  };
  for (let i = 0; i < S.length; i++) {
    if (i === S.length - 1) { if (!xs.length) push([S[i].lng, S[i].lat]); stopS[i] = d; break; }
    const l = byPair.get(`${S[i].id}>${S[i + 1].id}`);
    const coords: LngLat[] = l?.status === 'ok' && l.coords ? l.coords : [[S[i].lng, S[i].lat], [S[i + 1].lng, S[i + 1].lat]];
    push(coords[0]);
    stopS[i] = d;
    const at: number[] = [cum.length - 1];
    for (let k = 1; k < coords.length; k++) { push(coords[k]); at.push(cum.length - 1); }
    if (l?.status === 'ok' && l.turns) for (const t of l.turns) { const j = at[t.i]; if (j !== undefined) turns.push({ s: cum[j], c: t.c, n: t.n, x: t.x }); }
  }
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), cum: Float64Array.from(cum), n: xs.length, stopS, total: d, turns };
}

/** Bearing in degrees (0 = north) from a to b. */
export function bearing(ax: number, ay: number, bx: number, by: number) {
  const y = Math.sin((bx - ax) * RAD) * Math.cos(by * RAD);
  const x = Math.cos(ay * RAD) * Math.sin(by * RAD) - Math.sin(ay * RAD) * Math.cos(by * RAD) * Math.cos((bx - ax) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Index of the segment containing distance s (binary search). */
export function segAt(L: RouteLine, s: number): number {
  let lo = 0, hi = L.n - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (L.cum[m] <= s) lo = m; else hi = m; }
  return lo;
}

/** Position and heading at distance s along the route. */
export function pointAt(L: RouteLine, s: number): { p: LngLat; heading: number; idx: number } {
  if (L.n === 1) return { p: [L.x[0], L.y[0]], heading: 0, idx: 0 };
  s = Math.max(0, Math.min(L.total, s));
  const i = segAt(L, s);
  const seg = L.cum[i + 1] - L.cum[i];
  const t = seg > 0 ? (s - L.cum[i]) / seg : 0;
  return {
    p: [L.x[i] + (L.x[i + 1] - L.x[i]) * t, L.y[i] + (L.y[i + 1] - L.y[i]) * t],
    heading: bearing(L.x[i], L.y[i], L.x[i + 1], L.y[i + 1]),
    idx: i,
  };
}

/**
 * Snap a GPS point to the route. Searches a window around the last matched segment first
 * (so overlapping roads don't confuse it), then the whole line if nothing is close.
 */
export function matchToRoute(L: RouteLine, p: LngLat, hint: number, maxWindowM = 300): { d: number; s: number; idx: number } {
  const kx = Math.cos(p[1] * RAD) * 6371008.8 * RAD, ky = 6371008.8 * RAD;
  const scan = (from: number, to: number, step = 1) => {
    let best = { d: Infinity, s: 0, idx: from };
    for (let i = Math.max(0, from); i < Math.min(L.n - 1, to); i += step) {
      const ax = (L.x[i] - p[0]) * kx, ay = (L.y[i] - p[1]) * ky;
      const bx = (L.x[i + 1] - p[0]) * kx, by = (L.y[i + 1] - p[1]) * ky;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      const x = ax + t * dx, y = ay + t * dy, d = Math.sqrt(x * x + y * y);
      if (d < best.d) best = { d, s: L.cum[i] + t * (L.cum[i + 1] - L.cum[i]), idx: i };
    }
    return best;
  };
  if (L.n < 2) return { d: haversine(p, [L.x[0], L.y[0]]), s: 0, idx: 0 };
  // window: ~2 km behind, ~5 km ahead of the hint (by point count, adaptive to density)
  let a = hint, b = hint;
  while (a > 0 && L.cum[hint] - L.cum[a] < 2000) a--;
  while (b < L.n - 1 && L.cum[b] - L.cum[hint] < 5000) b++;
  const local = scan(a, b + 1);
  if (local.d <= maxWindowM) return local;
  const global = scan(0, L.n);
  return global.d < local.d ? global : local;
}

/** Slice of the route between two distances, as coordinates (for drawing progress). */
export function sliceLine(L: RouteLine, s0: number, s1: number): LngLat[] {
  if (L.n < 2 || s1 <= s0) return [];
  const a = pointAt(L, s0), b = pointAt(L, s1);
  const out: LngLat[] = [a.p];
  for (let i = a.idx + 1; i <= b.idx; i++) out.push([L.x[i], L.y[i]]);
  out.push(b.p);
  return out;
}

/**
 * Prefix the route with an approach path (e.g. from the rider's current location to stop `from`),
 * dropping everything before that stop. Stops before `from` get stopS = -1 (never "next").
 */
export function withApproach(L: RouteLine, ap: Approach, from: number): RouteLine {
  const approach = ap.coords;
  const turns: LineTurn[] = [];
  const xs: number[] = [], ys: number[] = [], cum: number[] = [];
  let d = 0;
  const push = (x: number, y: number) => {
    const n = xs.length;
    if (n && xs[n - 1] === x && ys[n - 1] === y) return;
    if (n) d += haversine([xs[n - 1], ys[n - 1]], [x, y]);
    xs.push(x); ys.push(y); cum.push(d);
  };
  const at: number[] = [];
  for (const p of approach) { push(p[0], p[1]); at.push(cum.length - 1); }
  for (const t of ap.turns ?? []) { const j = at[t.i]; if (j !== undefined) turns.push({ s: cum[j], c: t.c, n: t.n, x: t.x }); }
  const approachLen = d;
  const startS = L.stopS[from];
  const k = L.n > 1 ? segAt(L, startS) : 0;
  const start = pointAt(L, startS).p;
  push(start[0], start[1]);
  for (let i = k + 1; i < L.n; i++) push(L.x[i], L.y[i]);
  const stopS = new Float64Array(L.stopS.length);
  const offset = approachLen + (d - approachLen - (L.total - startS)) - startS;
  for (let i = 0; i < stopS.length; i++) stopS[i] = i < from ? -1 : L.stopS[i] + offset;
  for (const t of L.turns) if (t.s > startS + 1) turns.push({ ...t, s: t.s + offset });
  return { x: Float64Array.from(xs), y: Float64Array.from(ys), cum: Float64Array.from(cum), n: xs.length, stopS, total: d, turns };
}
