import type { LngLat } from '../core/geo';
import type { RouteLine } from './routeLine';

const RAD = Math.PI / 180;
const R = 6371008.8;
const CELL = 0.002; // degrees (~220 m)

export interface Near { d: number; i: number; s: number; bearing: number; p: LngLat }

/**
 * Grid index over the planned route's segments. Answers "nearest planned road to this point,
 * ignoring part of the route" in microseconds, even for 150,000 km routes.
 */
export class SegIndex {
  private cells = new Map<number, number[]>();
  constructor(public L: RouteLine) {
    for (let i = 0; i < L.n - 1; i++) {
      const x0 = Math.floor(Math.min(L.x[i], L.x[i + 1]) / CELL), x1 = Math.floor(Math.max(L.x[i], L.x[i + 1]) / CELL);
      const y0 = Math.floor(Math.min(L.y[i], L.y[i + 1]) / CELL), y1 = Math.floor(Math.max(L.y[i], L.y[i + 1]) / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue; // absurdly long straight (unrouted) segment
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy);
        const a = this.cells.get(k);
        if (a) a.push(i); else this.cells.set(k, [i]);
      }
    }
  }

  /** Distance from p to segment i (metres), with projection details. */
  segDist(p: LngLat, i: number) {
    const L = this.L;
    const kx = Math.cos(p[1] * RAD) * R * RAD, ky = R * RAD;
    const ax = (L.x[i] - p[0]) * kx, ay = (L.y[i] - p[1]) * ky;
    const bx = (L.x[i + 1] - p[0]) * kx, by = (L.y[i + 1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    const x = ax + t * dx, y = ay + t * dy;
    return { d: Math.hypot(x, y), t, bearing: (Math.atan2(dx, dy) / RAD + 360) % 360 };
  }

  /**
   * Nearest segment within `radiusM`, skipping segments whose along-route position lies in any
   * of the `skip` ranges [s0, s1] (e.g. the road the rider left from).
   */
  nearest(p: LngLat, radiusM: number, skip: [number, number][] = []): Near | null {
    const L = this.L;
    const dLat = radiusM / (R * RAD), dLng = dLat / Math.max(0.2, Math.cos(p[1] * RAD));
    const x0 = Math.floor((p[0] - dLng) / CELL), x1 = Math.floor((p[0] + dLng) / CELL);
    const y0 = Math.floor((p[1] - dLat) / CELL), y1 = Math.floor((p[1] + dLat) / CELL);
    let best: Near | null = null;
    const seen = new Set<number>();
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const a = this.cells.get(key(cx, cy));
      if (!a) continue;
      for (const i of a) {
        if (seen.has(i)) continue;
        seen.add(i);
        const s0 = L.cum[i], s1 = L.cum[i + 1];
        if (skip.some(([a0, a1]) => s1 >= a0 && s0 <= a1)) continue;
        const r = this.segDist(p, i);
        if (r.d <= radiusM && (!best || r.d < best.d)) {
          best = { d: r.d, i, s: s0 + r.t * (s1 - s0), bearing: r.bearing, p: [L.x[i] + (L.x[i + 1] - L.x[i]) * r.t, L.y[i] + (L.y[i + 1] - L.y[i]) * r.t] };
        }
      }
    }
    return best;
  }

  /** All segments within radius (for the route checker), excluding a range of s. */
  within(p: LngLat, radiusM: number, skip: [number, number]): number[] {
    const L = this.L;
    const dLat = radiusM / (R * RAD), dLng = dLat / Math.max(0.2, Math.cos(p[1] * RAD));
    const out: number[] = [];
    const seen = new Set<number>();
    for (let cx = Math.floor((p[0] - dLng) / CELL); cx <= Math.floor((p[0] + dLng) / CELL); cx++)
      for (let cy = Math.floor((p[1] - dLat) / CELL); cy <= Math.floor((p[1] + dLat) / CELL); cy++) {
        const a = this.cells.get(key(cx, cy));
        if (!a) continue;
        for (const i of a) {
          if (seen.has(i)) continue;
          seen.add(i);
          if (L.cum[i + 1] >= skip[0] && L.cum[i] <= skip[1]) continue;
          if (this.segDist(p, i).d <= radiusM) out.push(i);
        }
      }
    return out;
  }
}

const key = (cx: number, cy: number) => (cx + 200000) * 400000 + (cy + 200000);

/** Smallest angle between two bearings (0–180). */
export const angleDiff = (a: number, b: number) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; };
/** Same or opposite direction within `tol` degrees (parallel road / other carriageway). */
export const isParallel = (a: number, b: number, tol = 25) => { const d = angleDiff(a, b); return d < tol || d > 180 - tol; };
