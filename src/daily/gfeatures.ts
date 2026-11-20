import polyline from '@mapbox/polyline';
import { google as gs } from '../core/google';
import { gquota } from '../core/gquota';
import { loadMapsJs } from '../map/googleJs';
import type { LngLat } from '../core/geo';

/**
 * Google Maps Platform features used on top of the Google base map (Daily mode). Every call is counted
 * against its monthly cap; callers fall back to RideGrid's free versions on any error.
 * Google content (places, photos, routes) is only shown while the Google map is the base.
 */
declare const google: any;
const key = () => gs.settings.key;
export const googleReady = () => !!gs.settings.key && gs.settings.on && navigator.onLine;
async function lib(name: string) { await loadMapsJs(key()); return google.maps.importLibrary(name); }

export interface GPlace { id: string; name: string; address: string; p: LngLat; type?: string }

/** The place at (or right next to) a tapped point: Google place if any within 30 m, else the street address. */
export async function placeAt(p: LngLat): Promise<GPlace | null> {
  const { Place, SearchNearbyRankPreference } = await lib('places');
  gquota.take('nearby');
  const { places } = await Place.searchNearby({ fields: ['id', 'displayName', 'formattedAddress', 'location', 'primaryTypeDisplayName'],
    locationRestriction: { center: { lat: p[1], lng: p[0] }, radius: 30 }, maxResultCount: 1, rankPreference: SearchNearbyRankPreference.DISTANCE });
  const g = places?.[0];
  if (g) return { id: g.id, name: g.displayName ?? 'Place', address: g.formattedAddress ?? '', p: [g.location.lng(), g.location.lat()], type: g.primaryTypeDisplayName };
  const a = await addressAt(p);
  return a ? { id: '', name: a, address: 'Address', p } : null;
}

/** Street address of a point (Google Geocoding, live display only — never stored in the logbook). */
export async function addressAt(p: LngLat): Promise<string | null> {
  const { Geocoder } = await lib('geocoding');
  gquota.take('geocode');
  const r = await new Geocoder().geocode({ location: { lat: p[1], lng: p[0] } });
  return r.results?.[0]?.formatted_address ?? null;
}

/** Up to n photo URLs of a Google place. */
export async function placePhotos(placeId: string, n = 6): Promise<{ url: string; credit: string }[]> {
  const { Place } = await lib('places');
  gquota.take('photo');
  const pl = new Place({ id: placeId });
  await pl.fetchFields({ fields: ['photos'] });
  return (pl.photos ?? []).slice(0, n).map((ph: any) => ({ url: ph.getURI({ maxWidth: 800 }), credit: ph.authorAttributions?.map((a: any) => a.displayName).join(', ') ?? '' }));
}

/** Popular places around a point (Google "Explore nearby"). */
export async function exploreNearby(p: LngLat, types?: string[]): Promise<GPlace[]> {
  const { Place, SearchNearbyRankPreference } = await lib('places');
  gquota.take('nearby');
  const { places } = await Place.searchNearby({ fields: ['id', 'displayName', 'formattedAddress', 'location', 'primaryTypeDisplayName'],
    locationRestriction: { center: { lat: p[1], lng: p[0] }, radius: 5000 }, maxResultCount: 20, rankPreference: SearchNearbyRankPreference.POPULARITY,
    ...(types?.length ? { includedPrimaryTypes: types } : {}) });
  return (places ?? []).map((g: any) => ({ id: g.id, name: g.displayName, address: g.formattedAddress ?? '', p: [g.location.lng(), g.location.lat()], type: g.primaryTypeDisplayName }));
}

/** Places matching a query along a route (Google "search along route"). */
export async function searchAlongRoute(q: string, route: LngLat[]): Promise<GPlace[]> {
  gquota.take('textAlongRoute');
  const step = Math.max(1, Math.floor(route.length / 400));
  const enc = polyline.encode(route.filter((_, i) => i % step === 0).map(([x, y]) => [y, x]));
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.primaryTypeDisplayName' },
    body: JSON.stringify({ textQuery: q, searchAlongRouteParameters: { polyline: { encodedPolyline: enc } }, languageCode: 'en', regionCode: 'IN', pageSize: 20 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message ?? 'Google search along route failed');
  return (j.places ?? []).map((g: any) => ({ id: g.id, name: g.displayName?.text ?? '', address: g.formattedAddress ?? '', p: [g.location.longitude, g.location.latitude], type: g.primaryTypeDisplayName?.text }));
}

/** Small Street View photo URL (null if Google has no imagery there). */
export async function streetViewPhoto(p: LngLat): Promise<string | null> {
  const meta = await fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${p[1]},${p[0]}&radius=60&key=${key()}`).then((r) => r.json()).catch(() => null);
  if (meta?.status !== 'OK') return null; // metadata is free
  gquota.take('streetStatic');
  return `https://maps.googleapis.com/maps/api/streetview?size=640x320&location=${p[1]},${p[0]}&radius=60&source=outdoor&key=${key()}`;
}

/** Interactive Street View in an element. */
export async function openStreetView(el: HTMLElement, p: LngLat) {
  const { StreetViewPanorama } = await lib('streetView');
  gquota.take('streetView');
  return new StreetViewPanorama(el, { position: { lat: p[1], lng: p[0] }, pov: { heading: 0, pitch: 0 }, addressControl: true, fullscreenControl: false, motionTracking: true });
}

/** Ground elevation along a path (one request, up to 512 samples). */
export async function googleElevations(path: LngLat[], samples: number): Promise<number[]> {
  const { ElevationService } = await lib('elevation');
  gquota.take('elevation');
  const step = Math.max(1, Math.floor(path.length / 300));
  const r = await new ElevationService().getElevationAlongPath({ path: path.filter((_, i) => i % step === 0 || i === path.length - 1).map(([x, y]) => ({ lat: y, lng: x })), samples: Math.min(512, samples) });
  return (r.results ?? []).map((e: any) => e.elevation);
}

export interface GWeather { temp: number; feels: number; text: string; icon: string; rainPct: number; windKmh: number; hours: { t: number; temp: number; rainPct: number; text: string; icon: string }[] }
/** Google Weather: now + next 12 hours. */
export async function googleWeather(p: LngLat): Promise<GWeather> {
  gquota.take('weather', 2);
  const q = `key=${key()}&location.latitude=${p[1]}&location.longitude=${p[0]}`;
  const [now, fc] = await Promise.all([
    fetch(`https://weather.googleapis.com/v1/currentConditions:lookup?${q}`).then((r) => r.json()),
    fetch(`https://weather.googleapis.com/v1/forecast/hours:lookup?${q}&hours=12`).then((r) => r.json()),
  ]);
  if (now?.error) throw new Error(now.error.message);
  return {
    temp: now.temperature?.degrees, feels: now.feelsLikeTemperature?.degrees, text: now.weatherCondition?.description?.text ?? '', icon: now.weatherCondition?.iconBaseUri ? `${now.weatherCondition.iconBaseUri}.svg` : '',
    rainPct: now.precipitation?.probability?.percent ?? 0, windKmh: now.wind?.speed?.value ?? 0,
    hours: (fc.forecastHours ?? []).map((h: any) => ({ t: Date.parse(h.interval?.startTime), temp: h.temperature?.degrees, rainPct: h.precipitation?.probability?.percent ?? 0, text: h.weatherCondition?.description?.text ?? '', icon: h.weatherCondition?.iconBaseUri ? `${h.weatherCondition.iconBaseUri}.svg` : '' })),
  };
}

/** Air quality (India's AQI where available) and its main pollutant. */
export async function airQuality(p: LngLat): Promise<{ aqi: number; category: string; color: string; pollutant: string } | null> {
  gquota.take('airQuality');
  const r = await fetch(`https://airquality.googleapis.com/v1/currentConditions:lookup?key=${key()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: { latitude: p[1], longitude: p[0] }, extraComputations: ['LOCAL_AQI', 'DOMINANT_POLLUTANT_CONCENTRATION'], languageCode: 'en' }) }).then((x) => x.json());
  const i = r.indexes?.find((x: any) => x.code === 'ind_cpcb') ?? r.indexes?.[0];
  if (!i) return null;
  const c = i.color ?? {};
  return { aqi: i.aqi, category: i.category, pollutant: i.dominantPollutant ?? r.dominantPollutant ?? '', color: `rgb(${Math.round((c.red ?? 0) * 255)},${Math.round((c.green ?? 0) * 255)},${Math.round((c.blue ?? 0) * 255)})` };
}

/** Today's pollen (grass / tree / weed) levels. */
export async function pollen(p: LngLat): Promise<{ name: string; level: string }[]> {
  gquota.take('pollen');
  const r = await fetch(`https://pollen.googleapis.com/v1/forecast:lookup?key=${key()}&location.latitude=${p[1]}&location.longitude=${p[0]}&days=1&plantsDescription=false`).then((x) => x.json());
  return (r.dailyInfo?.[0]?.pollenTypeInfo ?? []).map((t: any) => ({ name: t.displayName, level: t.indexInfo?.category ?? 'No data' }));
}

/** Snap GPS points to roads (Google Roads API, 100 points per request). */
export async function googleSnap(pts: LngLat[]): Promise<LngLat[]> {
  const out: LngLat[] = [];
  for (let i = 0; i < pts.length - 1; i += 99) {
    const chunk = pts.slice(i, i + 100);
    gquota.take('snapRoads');
    const r = await fetch(`https://roads.googleapis.com/v1/snapToRoads?interpolate=true&key=${key()}&path=${chunk.map(([x, y]) => `${y.toFixed(6)},${x.toFixed(6)}`).join('|')}`).then((x) => x.json());
    if (r.error) throw new Error(r.error.message);
    out.push(...(r.snappedPoints ?? []).map((s: any) => [s.location.longitude, s.location.latitude] as LngLat));
  }
  return out;
}

/** Walking route (Google Routes, WALK). */
export async function googleWalk(from: LngLat, to: LngLat): Promise<{ coords: LngLat[]; distM: number; minutes: number }> {
  gquota.take('routesWalk');
  const ll = (p: LngLat) => ({ location: { latLng: { latitude: p[1], longitude: p[0] } } });
  const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline' },
    body: JSON.stringify({ origin: ll(from), destination: ll(to), travelMode: 'WALK', languageCode: 'en-IN', regionCode: 'IN' }) }).then((x) => x.json());
  const rt = r.routes?.[0];
  if (!rt) throw new Error(r.error?.message ?? 'No walking route');
  return { coords: polyline.decode(rt.polyline.encodedPolyline, 5).map(([a, b]) => [b, a] as LngLat), distM: rt.distanceMeters, minutes: parseFloat(rt.duration) / 60 };
}

/** Open a place / point in the phone's Google Maps app (free — Google shows ratings, hours, reviews there). */
export function openInGoogleMaps(p: LngLat, placeId?: string, name?: string) {
  const u = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name ?? `${p[1]},${p[0]}`)}${placeId ? `&query_place_id=${placeId}` : `&query=${p[1]},${p[0]}`}`;
  window.open(placeId ? u : `https://www.google.com/maps/search/?api=1&query=${p[1]},${p[0]}`, '_blank', 'noopener');
}

/** Two-wheeler travel times between all stops (Google Route Matrix, live traffic); seconds[i][j]. */
export async function roadTimes(pts: LngLat[]): Promise<number[][]> {
  const n = pts.length;
  if (n > 25) throw new Error('Too many stops for road-time sorting (max 25)');
  gquota.take('matrix', n * n);
  const wp = (p: LngLat) => ({ waypoint: { location: { latLng: { latitude: p[1], longitude: p[0] } } } });
  const r = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key(), 'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,condition' },
    body: JSON.stringify({ origins: pts.map(wp), destinations: pts.map(wp), travelMode: 'TWO_WHEELER', routingPreference: 'TRAFFIC_AWARE' }) });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error(j?.error?.message ?? 'Google road times failed');
  const m = Array.from({ length: n }, () => Array(n).fill(Infinity));
  for (const e of j) if (e.condition === 'ROUTE_EXISTS') m[e.originIndex ?? 0][e.destinationIndex ?? 0] = parseFloat(e.duration ?? '0');
  for (let i = 0; i < n; i++) m[i][i] = 0;
  return m;
}
