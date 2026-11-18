import type { LngLat } from '../core/geo';
import { haversine } from '../core/geo';
import { pointInPolygon } from '../core/india';
import { db } from '../core/db';
import { pointAt, type RouteLine } from './routeLine';

/**
 * Indian state / UT boundaries (Natural Earth admin-1, simplified; shipped with the app).
 * Used for the state-by-state km tracker (#34) and Inner Line Permit states (#31).
 */
export interface StatePoly { name: string; polys: LngLat[][]; bbox: [number, number, number, number] }
let states: StatePoly[] = [];
let loading: Promise<boolean> | null = null;

export function loadStates() {
  loading ??= (async () => {
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}data/india-states.json`);
      if (!r.ok) return false;
      const fc = (await r.json()) as GeoJSON.FeatureCollection;
      states = fc.features.map((f) => {
        const g = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
        const rings = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map((p) => p[0] as LngLat[]);
        const xs = rings.flat().map((c) => c[0]), ys = rings.flat().map((c) => c[1]);
        return { name: (f.properties as any).name as string, polys: rings, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
      });
      return true;
    } catch { return false; }
  })();
  return loading;
}
export const statePolygons = () => states;

/** Which state/UT a point is in (nearest by bounding box when it falls in a simplification gap). */
let lastHit: StatePoly | null = null;
export function stateAt(p: LngLat): string | null {
  if (lastHit && inside(lastHit, p)) return lastHit.name;
  for (const s of states) if (inside(s, p)) { lastHit = s; return s.name; }
  return null;
}
const inside = (s: StatePoly, p: LngLat) => p[0] >= s.bbox[0] && p[0] <= s.bbox[2] && p[1] >= s.bbox[1] && p[1] <= s.bbox[3] && s.polys.some((poly) => pointInPolygon(p, poly));

export interface StateKm { name: string; plannedKm: number; coveredKm: number }

/** Planned km per state (from the road geometry) and covered km per state (from real GPS rides). */
export async function stateBreakdown(L: RouteLine, tripId: string): Promise<StateKm[] | null> {
  if (!(await loadStates())) return null;
  const rows = new Map<string, StateKm>();
  const row = (n: string) => { let r = rows.get(n); if (!r) rows.set(n, (r = { name: n, plannedKm: 0, coveredKm: 0 })); return r; };
  const STEP = 500;
  let k = 0;
  for (let s = 0; s < L.total; s += STEP) {
    const n = stateAt(pointAt(L, s + STEP / 2).p) ?? 'Outside / border';
    row(n).plannedKm += Math.min(STEP, L.total - s) / 1000;
    if (++k % 5000 === 0) await new Promise((r) => setTimeout(r));
  }
  for (const ride of await db.rides.where('tripId').equals(tripId).filter((r) => !r.simulated).toArray()) {
    let prev: LngLat | null = null;
    for (const c of await db.rideChunks.where('rideId').equals(ride.id).sortBy('id')) for (const pt of c.pts) {
      const p: LngLat = [pt[1], pt[2]];
      if (prev && pt[3] <= 50) {
        const d = haversine(prev, p);
        if (d < 2000) row(stateAt(p) ?? 'Outside / border').coveredKm += d / 1000;
      }
      prev = p;
    }
  }
  return [...rows.values()].sort((a, b) => b.plannedKm - a.plannedKm);
}
