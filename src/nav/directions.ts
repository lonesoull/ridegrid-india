import { app } from '../core/app';
import { live } from './liveLocation';
import { google, googleRoute } from '../core/google';
import { engine } from '../core/engine';
import { haversine, lineLength, type LngLat } from '../core/geo';
import { inIndia } from '../core/india';

export interface Fix { p: LngLat; acc: number }

/** Current position + its accuracy in metres (laptops often report a rough Wi-Fi / IP location). */
export function myFix(): Promise<Fix> {
  // the always-on location is instant; ask the GPS only when there is none yet
  if (live.fix && Date.now() - live.fix.at < 30000) return Promise.resolve({ p: live.fix.p, acc: live.fix.acc });
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('GPS is not available on this device.'));
    navigator.geolocation.getCurrentPosition(
      (p) => res({ p: [p.coords.longitude, p.coords.latitude], acc: p.coords.accuracy }),
      (e) => rej(new Error(e.code === 1 ? 'Location permission denied — allow location for this site in the browser.' : `Could not get your location: ${e.message}`)),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}
export const myLocation = async (): Promise<LngLat> => (await myFix()).p;

/**
 * Sanity-check a location before routing from it. Returns a human explanation when it can't be trusted:
 * very rough accuracy (Wi-Fi / IP based, not GPS), outside India, or absurdly far from the route.
 */
export function fixProblem(f: Fix, target?: LngLat): string | null {
  const far = target ? haversine(f.p, target) : 0;
  const where = `${f.p[1].toFixed(3)}, ${f.p[0].toFixed(3)}`;
  if (!inIndia(f.p)) return `Your device reports a location outside India (${where}${target ? `, ${Math.round(far / 1000).toLocaleString('en-IN')} km from the route` : ''}). This usually means a VPN is on, or the location comes from your internet connection instead of GPS.`;
  if (f.acc > 1500) return `Your location is only accurate to about ±${(f.acc / 1000).toFixed(1)} km — it comes from Wi-Fi / internet, not GPS (common on laptops, or with a VPN on).`;
  if (target && far > 500000) return `Your device reports a location ${Math.round(far / 1000).toLocaleString('en-IN')} km from the route — that looks wrong (VPN or network location?).`;
  return null;
}

import type { Turn } from '../core/turns';
export interface Directions { from: LngLat; coords: LngLat[]; distM: number; routed: boolean; turns?: Turn[]; durS?: number; source?: 'google' | 'osrm' }

/** Road route from the rider's current location to stop i (straight line if the server can't be reached). */
export async function directionsTo(i: number, from?: LngLat): Promise<Directions> {
  const s = engine.stops[i];
  if (!s) throw new Error('No such stop');
  return directionsToPoint([s.lng, s.lat], from);
}

/** Road route from the rider (or `from`) to any point — Google two-wheeler with live traffic when available. */
export async function directionsToPoint(to: LngLat, from?: LngLat): Promise<Directions> {
  const me = from ?? (await myLocation());
  if (haversine(me, to) < 30) return { from: me, coords: [me, to], distM: haversine(me, to), routed: true };
  if (google.active) {
    try {
      const g = await googleRoute(google.settings.key, me, to);
      if (g.coords.length >= 2) return { from: me, coords: [me, ...g.coords, to], distM: g.distM, durS: g.durS, routed: true, source: 'google', turns: g.turns.map((t) => ({ ...t, i: t.i + 1 })) };
    } catch { /* fall back to OSRM below */ }
  }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const [leg] = await app.queue.providerFor([me, to]).route([me, to], ctl.signal);
    clearTimeout(t);
    if (leg?.coords.length >= 2) return { from: me, coords: [me, ...leg.coords, to], distM: leg.distM, routed: true, source: 'osrm', turns: leg.turns?.map((t) => ({ ...t, i: t.i + 1 })) };
  } catch { /* fall through */ }
  return { from: me, coords: [me, to], distM: lineLength([me, to]), routed: false };
}

/** Rough riding time at an average 35 km/h (city + highway mix). */
export const rideMinutes = (m: number) => Math.max(1, Math.round(m / 1000 / 35 * 60));
