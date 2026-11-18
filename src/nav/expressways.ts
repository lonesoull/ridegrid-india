import type { LngLat } from '../core/geo';
import { pointAt, type RouteLine } from './routeLine';
import { isParallel } from './spatial';

/**
 * Two-wheeler-banned roads (Indian expressways / motorways and anything tagged motorcycle=no),
 * built from OpenStreetMap by the "Build India data" job and shipped with the app (works offline).
 */
const RAD = Math.PI / 180, R = 6371008.8, CELL = 0.002;

export interface BannedRoad { name: string; ref: string; access: string }
export interface Hit { d: number; road: BannedRoad; bearing: number; p: LngLat }

export class LineIndex {
  private segs: { x0: number; y0: number; x1: number; y1: number; road: number }[] = [];
  private cells = new Map<number, number[]>();
  constructor(public roads: BannedRoad[], lines: LngLat[][]) {
    lines.forEach((c, road) => {
      for (let i = 0; i < c.length - 1; i++) {
        const k = this.segs.push({ x0: c[i][0], y0: c[i][1], x1: c[i + 1][0], y1: c[i + 1][1], road }) - 1;
        const s = this.segs[k];
        for (let cx = Math.floor(Math.min(s.x0, s.x1) / CELL); cx <= Math.floor(Math.max(s.x0, s.x1) / CELL); cx++)
          for (let cy = Math.floor(Math.min(s.y0, s.y1) / CELL); cy <= Math.floor(Math.max(s.y0, s.y1) / CELL); cy++) {
            const key = (cx + 200000) * 400000 + (cy + 200000);
            const a = this.cells.get(key);
            if (a) a.push(k); else this.cells.set(key, [k]);
          }
      }
    });
  }
  get size() { return this.segs.length; }

  nearest(p: LngLat, radiusM: number): Hit | null {
    const dLat = radiusM / (R * RAD), dLng = dLat / Math.max(0.2, Math.cos(p[1] * RAD));
    const kx = Math.cos(p[1] * RAD) * R * RAD, ky = R * RAD;
    let best: Hit | null = null;
    const seen = new Set<number>();
    for (let cx = Math.floor((p[0] - dLng) / CELL); cx <= Math.floor((p[0] + dLng) / CELL); cx++)
      for (let cy = Math.floor((p[1] - dLat) / CELL); cy <= Math.floor((p[1] + dLat) / CELL); cy++) {
        const a = this.cells.get((cx + 200000) * 400000 + (cy + 200000));
        if (!a) continue;
        for (const k of a) {
          if (seen.has(k)) continue;
          seen.add(k);
          const s = this.segs[k];
          const ax = (s.x0 - p[0]) * kx, ay = (s.y0 - p[1]) * ky, bx = (s.x1 - p[0]) * kx, by = (s.y1 - p[1]) * ky;
          const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
          const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d <= radiusM && (!best || d < best.d)) {
            best = { d, road: this.roads[s.road], bearing: (Math.atan2(dx, dy) / RAD + 360) % 360, p: [s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t] };
          }
        }
      }
    return best;
  }
}

let loading: Promise<{ fc: GeoJSON.FeatureCollection; idx: LineIndex } | null> | null = null;

/** Load the shipped expressway data once (null if the data file isn't available yet). */
export function loadExpressways() {
  loading ??= (async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}data/expressways.json`);
      if (!r.ok) return null;
      const fc = (await r.json()) as GeoJSON.FeatureCollection;
      const roads: BannedRoad[] = [], lines: LngLat[][] = [];
      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString') continue;
        const pr = f.properties as any;
        roads.push({ name: pr.n || pr.r || 'Expressway', ref: pr.r ?? '', access: pr.mc });
        lines.push(f.geometry.coordinates as LngLat[]);
      }
      return { fc, idx: new LineIndex(roads, lines) };
    } catch { return null; }
  })();
  return loading;
}

export interface ExpresswayIssue { s1: number; s1End: number; d: number; p: LngLat; p2: LngLat; road: BannedRoad }

/** Parts of the planned route that run ON a banned road (within 15 m and in the same direction for ≥ 100 m). */
export async function routeOnExpressways(L: RouteLine, onProgress?: (f: number) => void): Promise<ExpresswayIssue[] | null> {
  const data = await loadExpressways();
  if (!data) return null;
  const out: ExpresswayIssue[] = [];
  let cur: ExpresswayIssue | null = null;
  let n = 0;
  for (let s = 0; s <= L.total; s += 20) {
    const at = pointAt(L, s);
    const h = data.idx.nearest(at.p, 15);
    const on = h && isParallel(at.heading, h.bearing, 30);
    if (on && h) {
      if (cur && s - cur.s1End <= 41) { cur.s1End = s; cur.d = Math.min(cur.d, h.d); }
      else { if (cur && cur.s1End - cur.s1 >= 100) out.push(cur); cur = { s1: s, s1End: s, d: h.d, p: at.p, p2: h.p, road: h.road }; }
    } else if (cur && s - cur.s1End > 41) { if (cur.s1End - cur.s1 >= 100) out.push(cur); cur = null; }
    if (++n % 20000 === 0) { onProgress?.(s / L.total); await new Promise((r) => setTimeout(r)); }
  }
  if (cur && cur.s1End - cur.s1 >= 100) out.push(cur);
  return out;
}

/** Does this road geometry run ON a banned road (≥ 100 m within 15 m, same direction)? */
export async function legOnBanned(coords: LngLat[]): Promise<BannedRoad | null> {
  const data = await loadExpressways();
  if (!data || coords.length < 2) return null;
  let run = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const kx = Math.cos(a[1] * RAD) * R * RAD, ky = R * RAD;
    const segM = Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
    const hd = (Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * ky) / RAD + 360) % 360;
    const steps = Math.max(1, Math.ceil(segM / 20));
    for (let k = 0; k < steps; k++) {
      const p: LngLat = [a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps];
      const h = data.idx.nearest(p, 15);
      if (h && isParallel(hd, h.bearing, 30)) { run += segM / steps; if (run >= 100) return h.road; } else run = 0;
    }
  }
  return null;
}

/** No-go rectangles around banned roads near a leg (for Valhalla's exclude_polygons; ~10 km perimeter budget). */
export async function bannedPolygonsNear(from: LngLat, to: LngLat, widthM = 25, budgetM = 9500): Promise<LngLat[][]> {
  const data = await loadExpressways();
  if (!data) return [];
  const pad = 0.05;
  const box = [Math.min(from[0], to[0]) - pad, Math.min(from[1], to[1]) - pad, Math.max(from[0], to[0]) + pad, Math.max(from[1], to[1]) + pad];
  const mid: LngLat = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const segs: { a: LngLat; b: LngLat; d: number }[] = [];
  for (const f of data.fc.features) {
    const c = (f.geometry as GeoJSON.LineString).coordinates as LngLat[];
    for (let i = 0; i < c.length - 1; i++) {
      const a = c[i], b = c[i + 1];
      if (Math.max(a[0], b[0]) < box[0] || Math.min(a[0], b[0]) > box[2] || Math.max(a[1], b[1]) < box[1] || Math.min(a[1], b[1]) > box[3]) continue;
      segs.push({ a, b, d: Math.hypot(a[0] - mid[0], a[1] - mid[1]) });
    }
  }
  segs.sort((x, y) => x.d - y.d);
  const out: LngLat[][] = [];
  let used = 0;
  for (const { a, b } of segs) {
    const kx = Math.cos(a[1] * RAD) * R * RAD, ky = R * RAD;
    let dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
    const len = Math.hypot(dx, dy) || 1;
    if (used + 2 * len + 4 * widthM > budgetM) break;
    dx /= len; dy /= len;
    const ox = (-dy * widthM) / kx, oy = (dx * widthM) / ky, ex = (dx * widthM) / kx, ey = (dy * widthM) / ky;
    const ring: LngLat[] = [[a[0] - ex + ox, a[1] - ey + oy], [b[0] + ex + ox, b[1] + ey + oy], [b[0] + ex - ox, b[1] + ey - oy], [a[0] - ex - ox, a[1] - ey - oy]];
    ring.push(ring[0]);
    out.push(ring.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)] as LngLat));
    used += 2 * len + 4 * widthM;
  }
  return out;
}
