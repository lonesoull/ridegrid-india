import { google } from './google';
import { haversine, type LngLat } from './geo';
import { gquota } from './gquota';

/**
 * Place search. Google Places (New) when Google mode is on (its results may only be shown on Google's map,
 * which Google mode provides); otherwise Photon — free OpenStreetMap search that allows search-as-you-type.
 */
export interface Place {
  id: string; name: string; address: string;
  p?: LngLat;               // known immediately for Photon; fetched on demand for Google
  provider: 'google' | 'osm';
  distM?: number;
}

let session = '';
const newSession = () => (session = crypto.randomUUID());

export async function searchPlaces(q: string, near: LngLat | null, signal?: AbortSignal): Promise<Place[]> {
  q = q.trim();
  if (q.length < 2) return [];
  if (google.active) {
    try { return await googleAutocomplete(q, near, signal); } catch (e) { if ((e as any)?.name === 'AbortError') throw e; /* fall back to OSM */ }
  }
  return photon(q, near, signal);
}

async function photon(q: string, near: LngLat | null, signal?: AbortSignal): Promise<Place[]> {
  const u = new URLSearchParams({ q, limit: '10', lang: 'en' });
  if (near) { u.set('lat', near[1].toFixed(5)); u.set('lon', near[0].toFixed(5)); }
  u.append('bbox', '68.0,6.5,97.5,35.7'); // India
  const r = await fetch(`https://photon.komoot.io/api/?${u}`, { signal });
  if (!r.ok) throw new Error(`Search failed (${r.status})`);
  const j = await r.json();
  return (j.features ?? []).map((f: any): Place => {
    const pr = f.properties ?? {};
    const p: LngLat = f.geometry.coordinates;
    const addr = [pr.street && `${pr.housenumber ? pr.housenumber + ' ' : ''}${pr.street}`, pr.district ?? pr.locality, pr.city ?? pr.county, pr.state].filter(Boolean);
    return { id: `osm:${pr.osm_type}${pr.osm_id}`, name: pr.name ?? addr[0] ?? q, address: [...new Set(addr)].join(', '), p, provider: 'osm', distM: near ? haversine(near, p) : undefined };
  });
}

async function googleAutocomplete(q: string, near: LngLat | null, signal?: AbortSignal): Promise<Place[]> {
  gquota.take('autocomplete');
  if (!session) newSession();
  const body: any = { input: q, includedRegionCodes: ['in'], languageCode: 'en', sessionToken: session };
  if (near) { body.origin = { latitude: near[1], longitude: near[0] }; body.locationBias = { circle: { center: { latitude: near[1], longitude: near[0] }, radius: 50000 } }; }
  const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': google.settings.key }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message ?? 'Google search failed');
  return (j.suggestions ?? []).filter((s: any) => s.placePrediction).map((s: any): Place => {
    const pp = s.placePrediction;
    return { id: `g:${pp.placeId}`, name: pp.structuredFormat?.mainText?.text ?? pp.text?.text, address: pp.structuredFormat?.secondaryText?.text ?? '', provider: 'google', distM: pp.distanceMeters };
  });
}

/** Coordinates for a place (Google needs a details call; ends the billing session). */
export async function resolvePlace(pl: Place): Promise<Place> {
  if (pl.p) return pl;
  gquota.take('placeBasic');
  const id = pl.id.slice(2);
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}?sessionToken=${session}`, {
    headers: { 'X-Goog-Api-Key': google.settings.key, 'X-Goog-FieldMask': 'location,displayName,formattedAddress' },
  });
  const j = await r.json();
  newSession();
  if (!r.ok || !j.location) throw new Error(j?.error?.message ?? 'Could not load the place');
  return { ...pl, p: [j.location.longitude, j.location.latitude], name: j.displayName?.text ?? pl.name, address: j.formattedAddress ?? pl.address };
}

/** Quick categories (search terms work for both Google and OpenStreetMap). */
export const CATEGORIES: { label: string; q: string }[] = [
  { label: 'Fuel', q: 'petrol pump' },
  { label: 'Police', q: 'police station' },
  { label: 'Hotel', q: 'hotel' },
  { label: 'Hospital', q: 'hospital' },
  { label: 'Mechanic', q: 'motorcycle repair' },
  { label: 'Food', q: 'restaurant' },
];
