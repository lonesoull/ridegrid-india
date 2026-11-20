import polyline from '@mapbox/polyline';
import type { LngLat } from '../core/geo';
import { google } from '../core/google';

/**
 * Public transport routes (OsmAnd public-transport routing): bus, metro, suburban train, rail.
 * Google Routes API (TRANSIT) with the rider's key; otherwise Transitous (free, open GTFS data).
 */
export interface TransitStep { mode: 'WALK' | 'BUS' | 'SUBWAY' | 'TRAIN' | 'RAIL' | 'TRAM' | 'FERRY' | 'OTHER'; line?: string; color?: string; from?: string; to?: string; dep?: string; arr?: string; stops?: number; headsign?: string; minutes: number; coords: LngLat[] }
export interface TransitRoute { minutes: number; dep?: string; arr?: string; transfers: number; walkM: number; steps: TransitStep[]; source: string }

const VEH: Record<string, TransitStep['mode']> = { BUS: 'BUS', INTERCITY_BUS: 'BUS', TROLLEYBUS: 'BUS', SUBWAY: 'SUBWAY', METRO_RAIL: 'SUBWAY', HEAVY_RAIL: 'TRAIN', COMMUTER_TRAIN: 'TRAIN', HIGH_SPEED_TRAIN: 'TRAIN', LONG_DISTANCE_TRAIN: 'TRAIN', RAIL: 'RAIL', MONORAIL: 'SUBWAY', TRAM: 'TRAM', LIGHT_RAIL: 'TRAM', FERRY: 'FERRY' };
const tm = (s?: string) => (s ? new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : undefined);
const secs = (d?: string) => (d ? parseFloat(d) : 0);

async function viaGoogle(from: LngLat, to: LngLat, when?: Date): Promise<TransitRoute[]> {
  const ll = (p: LngLat) => ({ location: { latLng: { latitude: p[1], longitude: p[0] } } });
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': google.settings.key,
      'X-Goog-FieldMask': 'routes.duration,routes.legs.steps.travelMode,routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.transitDetails,routes.legs.steps.staticDuration,routes.legs.steps.distanceMeters' },
    body: JSON.stringify({ origin: ll(from), destination: ll(to), travelMode: 'TRANSIT', computeAlternativeRoutes: true, languageCode: 'en-IN', regionCode: 'IN',
      ...(when ? { departureTime: when.toISOString() } : {}) }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message ?? `Google transit error ${r.status}`);
  return (j.routes ?? []).map((rt: any): TransitRoute => {
    const steps: TransitStep[] = [];
    for (const st of rt.legs?.[0]?.steps ?? []) {
      const coords = polyline.decode(st.polyline?.encodedPolyline ?? '', 5).map(([a, b]) => [b, a] as LngLat);
      const td = st.transitDetails;
      const last = steps[steps.length - 1];
      if (st.travelMode === 'WALK' && last?.mode === 'WALK') { last.coords.push(...coords); last.minutes += secs(st.staticDuration) / 60; continue; }
      steps.push(td ? {
        mode: VEH[td.transitLine?.vehicle?.type] ?? 'OTHER', line: td.transitLine?.nameShort || td.transitLine?.name, color: td.transitLine?.color, headsign: td.headsign,
        from: td.stopDetails?.departureStop?.name, to: td.stopDetails?.arrivalStop?.name, dep: tm(td.stopDetails?.departureTime), arr: tm(td.stopDetails?.arrivalTime),
        stops: td.stopCount, minutes: secs(st.staticDuration) / 60, coords,
      } : { mode: 'WALK', minutes: secs(st.staticDuration) / 60, coords });
    }
    const tr = steps.filter((s) => s.mode !== 'WALK');
    return { minutes: secs(rt.duration) / 60, dep: tr[0]?.dep, arr: tr[tr.length - 1]?.arr, transfers: Math.max(0, tr.length - 1), walkM: 0, steps, source: 'Google' };
  });
}

async function viaTransitous(from: LngLat, to: LngLat, when?: Date): Promise<TransitRoute[]> {
  const q = new URLSearchParams({ fromPlace: `${from[1]},${from[0]}`, toPlace: `${to[1]},${to[0]}`, ...(when ? { time: when.toISOString() } : {}) });
  const j = await fetch(`https://api.transitous.org/api/v1/plan?${q}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return (j?.itineraries ?? []).map((it: any): TransitRoute => {
    const steps: TransitStep[] = (it.legs ?? []).map((l: any) => ({
      mode: l.mode === 'WALK' ? 'WALK' : /BUS|COACH/.test(l.mode) ? 'BUS' : /SUBWAY|METRO/.test(l.mode) ? 'SUBWAY' : /RAIL|TRAIN/.test(l.mode) ? 'TRAIN' : /TRAM/.test(l.mode) ? 'TRAM' : /FERRY/.test(l.mode) ? 'FERRY' : 'OTHER',
      line: l.routeShortName || l.routeLongName, color: l.routeColor ? `#${l.routeColor}` : undefined, headsign: l.headsign, from: l.from?.name, to: l.to?.name, dep: tm(l.startTime), arr: tm(l.endTime),
      stops: l.intermediateStops?.length, minutes: (Date.parse(l.endTime) - Date.parse(l.startTime)) / 60000,
      coords: l.legGeometry?.points ? polyline.decode(l.legGeometry.points, l.legGeometry.precision ?? 7).map(([a, b]) => [b, a] as LngLat) : [],
    }));
    return { minutes: it.duration / 60, dep: tm(it.startTime), arr: tm(it.endTime), transfers: it.transfers ?? 0, walkM: 0, steps, source: 'Transitous (open data)' };
  });
}

export async function transitRoutes(from: LngLat, to: LngLat, when?: Date): Promise<TransitRoute[]> {
  if (google.settings.key) { try { const r = await viaGoogle(from, to, when); if (r.length) return r; } catch (e) { console.warn(e); } }
  const r = await viaTransitous(from, to, when);
  if (!r.length) throw new Error('No public transport found for this trip (add a Google key in Tools for better coverage in India)');
  return r;
}

export const MODE_ICON: Record<TransitStep['mode'], string> = { WALK: '🚶', BUS: '🚌', SUBWAY: '🚇', TRAIN: '🚆', RAIL: '🚆', TRAM: '🚊', FERRY: '⛴', OTHER: '🚐' };
