import { google, stepsToLeg } from '../core/google';
import { gquota, QuotaError } from '../core/gquota';
import { lineLength, type LngLat } from '../core/geo';
import { engine } from '../core/engine';
import { routing, type Provider, type LegResult, type DailyRouteOpts } from '../core/router';

/**
 * Daily routes planned by Google (Routes API, TWO_WHEELER, live traffic) — like the Google Maps app.
 * Up to 10 legs per request (Google's Enterprise level is billed per request, not per leg). RideGrid's own
 * routers take over offline, when the monthly cap is reached, when Google fails, or for options Google
 * can't follow (avoid unpaved roads, shortest route, roads you blocked).
 */
let pauseUntil = 0;
export const googleRouting = {
  /** use Google for Daily legs right now? */
  preferred(): boolean {
    if (engine.trip?.kind !== 'daily' || !google.settings.key || !google.settings.on || !navigator.onLine || Date.now() < pauseUntil) return false;
    const d: DailyRouteOpts | null = routing.dailyOpts?.() ?? null;
    if (d && (d.avoidUnpaved || d.shortest)) return false;
    if (routing.avoidSegs?.()?.length || routing.avoidBorders?.()) return false; // Google has no avoid-borders option
    return gquota.can('routes2w');
  },
  pause(ms: number) { pauseUntil = Date.now() + ms; },
};

export const googleProvider: Provider = {
  id: 'google', label: 'Google (two-wheeler, live traffic)', maxWaypoints: 11, minIntervalMs: 400,
  async route(points, signal): Promise<LegResult[]> {
    try { gquota.take('routes2w'); } catch (e) { googleRouting.pause(60 * 60000); throw e; }
    const ll = (p: LngLat) => ({ location: { latLng: { latitude: p[1], longitude: p[0] } } });
    const d = routing.dailyOpts?.();
    const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': google.settings.key,
        'X-Goog-FieldMask': 'routes.legs.distanceMeters,routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.navigationInstruction' },
      body: JSON.stringify({
        origin: ll(points[0]), destination: ll(points[points.length - 1]),
        intermediates: points.slice(1, -1).map(ll),
        travelMode: 'TWO_WHEELER', routingPreference: 'TRAFFIC_AWARE', polylineQuality: 'HIGH_QUALITY',
        routeModifiers: { avoidTolls: !!d?.avoidToll, avoidHighways: !!d?.avoidMotorway, avoidFerries: !!d?.avoidFerry },
        languageCode: 'en-IN', regionCode: 'IN', units: 'METRIC',
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.routes?.[0]) { googleRouting.pause(10 * 60000); throw new Error(j?.error?.message ?? `Google routes ${r.status}`); }
    return j.routes[0].legs.map((leg: any) => { const { coords, turns } = stepsToLeg(leg.steps); return { coords, distM: leg.distanceMeters ?? lineLength(coords), turns }; });
  },
  async nearest() { return null; },
};
export { QuotaError };
