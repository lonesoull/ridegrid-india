import type { LngLat } from '../core/geo';
import { haversine } from '../core/geo';
import { elevations } from './mapLayers';

/**
 * Height above sea level for the altitude widget. Phones report GPS height above the ellipsoid, which in
 * India is 30–100 m below sea level (e.g. about −81 m in Chennai), so we use the terrain map's ground
 * height instead (works offline once terrain is downloaded). Updated at most every 10 s or 100 m.
 */
let last: { p: LngLat; at: number; h: number | null } | null = null;
let busy = false;
export function seaLevelAltitude(p: LngLat | null, onUpdate: () => void): number | null {
  if (!p) return null;
  if (!busy && (!last || Date.now() - last.at > 10000 || haversine(last.p, p) > 100)) {
    busy = true;
    void elevations([p]).then(([h]) => { last = { p, at: Date.now(), h: Number.isFinite(h) ? h : null }; onUpdate(); })
      .catch(() => { last = { p, at: Date.now(), h: null }; }).finally(() => { busy = false; });
  }
  return last?.h ?? null;
}
