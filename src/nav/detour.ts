import { decode6, haversine, type LngLat } from '../core/geo';
import { valhallaTurn, type Turn, type TurnCode } from '../core/turns';
import type { RouteLine } from './routeLine';
import { bearing } from './routeLine';
import type { SegIndex } from './spatial';

const RAD = Math.PI / 180, R = 6371008.8;

/** Turn instructions derived purely from geometry (for "return the way I came" along a GPS track). */
export function deriveTurns(coords: LngLat[]): Turn[] {
  const out: Turn[] = [];
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  let lastTurnS = -Infinity;
  for (let k = 1; k < coords.length - 1; k++) {
    let a = k - 1; while (a > 0 && cum[k] - cum[a] < 15) a--;
    let b = k + 1; while (b < coords.length - 1 && cum[b] - cum[k] < 15) b++;
    if (cum[k] - cum[a] < 5 || cum[b] - cum[k] < 5) continue;
    const bin = bearing(coords[a][0], coords[a][1], coords[k][0], coords[k][1]);
    const bout = bearing(coords[k][0], coords[k][1], coords[b][0], coords[b][1]);
    const d = ((bout - bin + 540) % 360) - 180; // + = right
    const m = Math.abs(d);
    if (m < 35 || cum[k] - lastTurnS < 25) continue;
    const side = d > 0 ? 'right' : 'left';
    const c = (m > 165 ? 'uturn' : m > 135 ? `sharp-${side}` : m > 60 ? side : `slight-${side}`) as TurnCode;
    out.push({ i: k, c });
    lastTurnS = cum[k];
  }
  return out;
}

/** Remove consecutive near-duplicates and make a clean path (for the reverse GPS track). */
export function cleanPath(coords: LngLat[], minM = 5): LngLat[] {
  const out: LngLat[] = [];
  for (const p of coords) if (!out.length || haversine(out[out.length - 1], p) >= minM) out.push(p);
  return out;
}

/**
 * Buffer polygons ("no-go strips") around planned-route parts near a detour, for Valhalla's
 * exclude_polygons. Skips the departure vicinity. Public Valhalla caps the total perimeter
 * (~10 km), so the closest strips are included first.
 */
export function noGoPolygons(L: RouteLine, from: LngLat, to: LngLat, skip: [number, number], widthM: number, budgetM = 9500): LngLat[][] {
  const pad = 3000;
  const minX = Math.min(from[0], to[0]), maxX = Math.max(from[0], to[0]);
  const minY = Math.min(from[1], to[1]), maxY = Math.max(from[1], to[1]);
  const dLat = pad / (R * RAD), dLng = dLat / Math.cos(((minY + maxY) / 2) * RAD);
  const inBox = (i: number) => L.x[i] >= minX - dLng && L.x[i] <= maxX + dLng && L.y[i] >= minY - dLat && L.y[i] <= maxY + dLat;
  // collect runs of route points inside the box and outside the skip range, ~200 m long each
  const runs: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < L.n; i++) {
    const ok = inBox(i) && !(L.cum[i] >= skip[0] && L.cum[i] <= skip[1]);
    if (ok) {
      cur.push(i);
      if (L.cum[i] - L.cum[cur[0]] > 200) { runs.push(cur); cur = [i]; }
    } else if (cur.length) { if (cur.length > 1) runs.push(cur); cur = []; }
  }
  if (cur.length > 1) runs.push(cur);
  const mid: LngLat = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  runs.sort((a, b) => haversine([L.x[a[0]], L.y[a[0]]], mid) - haversine([L.x[b[0]], L.y[b[0]]], mid));
  const polys: LngLat[][] = [];
  let used = 0;
  for (const run of runs) {
    const len = L.cum[run[run.length - 1]] - L.cum[run[0]];
    const per = 2 * len + 4 * widthM;
    if (used + per > budgetM) continue;
    const left: LngLat[] = [], right: LngLat[] = [];
    run.forEach((i, k) => {
      const j0 = run[Math.max(0, k - 1)], j1 = run[Math.min(run.length - 1, k + 1)];
      const kx = Math.cos(L.y[i] * RAD) * R * RAD, ky = R * RAD;
      let dx = (L.x[j1] - L.x[j0]) * kx, dy = (L.y[j1] - L.y[j0]) * ky;
      const n = Math.hypot(dx, dy) || 1; dx /= n; dy /= n;
      // extend the ends a little so the strip also covers the junction itself
      const ext = k === 0 ? -widthM : k === run.length - 1 ? widthM : 0;
      const cx = L.x[i] + (dx * ext) / kx, cy = L.y[i] + (dy * ext) / ky;
      left.push([cx - (dy * widthM) / kx, cy + (dx * widthM) / ky]);
      right.push([cx + (dy * widthM) / kx, cy - (dx * widthM) / ky]);
    });
    const ring = [...left, ...right.reverse()];
    ring.push(ring[0]);
    polys.push(ring.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)] as LngLat));
    used += per;
  }
  return polys;
}

export interface SafeRoute { coords: LngLat[]; turns: Turn[]; distM: number; minGapM: number; ok: boolean }

/** Valhalla motorcycle route avoiding the no-go strips, then double-checked against the full index. */
export async function safeRoute(from: LngLat, to: LngLat, L: RouteLine, idx: SegIndex, skip: [number, number], gapM: number,
  base = 'https://valhalla1.openstreetmap.de'): Promise<SafeRoute> {
  const polys = noGoPolygons(L, from, to, skip, gapM + 10);
  const body = {
    locations: [{ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] }],
    costing: 'motorcycle', directions_type: 'maneuvers', units: 'kilometers',
    costing_options: { motorcycle: { use_highways: 0 } }, // never onto expressways (two-wheeler ban)
    ...(polys.length ? { exclude_polygons: polys } : {}),
  };
  const r = await fetch(`${base}/route`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ? `No safe route: ${j.error}` : `Routing server error ${r.status}`);
  const leg = j.trip.legs[0];
  const coords = decode6(leg.shape);
  const turns = (leg.maneuvers ?? []).map(valhallaTurn).filter(Boolean) as Turn[];
  const minGapM = minGapAlong(coords, idx, skip, gapM * 4);
  return { coords, turns, distM: (leg.summary?.length ?? 0) * 1000, minGapM, ok: minGapM >= gapM };
}

/** Closest approach of a path to any planned road outside `skip` (sampled every ~10 m). */
export function minGapAlong(coords: LngLat[], idx: SegIndex, skip: [number, number], cap: number): number {
  let min = cap;
  for (let i = 0; i < coords.length; i++) {
    const a = coords[i], b = coords[i + 1] ?? a;
    const steps = Math.max(1, Math.ceil(haversine(a, b) / 10));
    for (let k = 0; k < steps; k++) {
      const p: LngLat = [a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps];
      const n = idx.nearest(p, min, [skip]);
      if (n && n.d < min) min = n.d;
    }
  }
  return min;
}
