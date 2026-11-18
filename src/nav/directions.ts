import { app } from '../core/app';
import { engine } from '../core/engine';
import { haversine, lineLength, type LngLat } from '../core/geo';

export function myLocation(): Promise<LngLat> {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('GPS is not available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (p) => res([p.coords.longitude, p.coords.latitude]),
      (e) => rej(new Error(e.code === 1 ? 'Location permission denied — allow location for this site in the browser.' : `Could not get your location: ${e.message}`)),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

export interface Directions { from: LngLat; coords: LngLat[]; distM: number; routed: boolean }

/** Road route from the rider's current location to stop i (straight line if the server can't be reached). */
export async function directionsTo(i: number, from?: LngLat): Promise<Directions> {
  const s = engine.stops[i];
  if (!s) throw new Error('No such stop');
  const me = from ?? (await myLocation());
  const to: LngLat = [s.lng, s.lat];
  if (haversine(me, to) < 30) return { from: me, coords: [me, to], distM: haversine(me, to), routed: true };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const [leg] = await app.queue.provider.route([me, to], ctl.signal);
    clearTimeout(t);
    if (leg?.coords.length >= 2) return { from: me, coords: [me, ...leg.coords, to], distM: leg.distM, routed: true };
  } catch { /* fall through */ }
  return { from: me, coords: [me, to], distM: lineLength([me, to]), routed: false };
}

/** Rough riding time at an average 35 km/h (city + highway mix). */
export const rideMinutes = (m: number) => Math.max(1, Math.round(m / 1000 / 35 * 60));
