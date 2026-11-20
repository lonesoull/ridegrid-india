import polyline from '@mapbox/polyline';
import { getSetting, putSetting } from './db';
import { lineLength, type LngLat } from './geo';
import type { Turn, TurnCode } from './turns';
import { gquota } from './gquota';

/**
 * Google Maps Platform integration ("Google mode").
 * Google's terms require Google route/traffic content to be shown on a Google basemap, so when this
 * mode is on the basemap switches to Google 2D tiles (Map Tiles API) and Google Routes is used for
 * "from my location" directions and re-routes. The key lives only in this browser (never in the repo).
 */
export interface GoogleSettings { key: string; on: boolean; traffic: boolean; /** optional Map ID (vector map styling) */ mapId: string }
export const DEFAULT_GOOGLE: GoogleSettings = { key: '', on: false, traffic: true, mapId: '' };

export const google = {
  settings: DEFAULT_GOOGLE,
  async load() {
    this.settings = { ...DEFAULT_GOOGLE, ...(await getSetting('google', DEFAULT_GOOGLE)) };
    // Google Maps is the base map in both modes: switch it on once for riders who already added a key
    if (this.settings.key && !(await getSetting('googleBaseOn', false))) { await putSetting('googleBaseOn', true); await this.save({ on: true }); }
    return this.settings;
  },
  async save(p: Partial<GoogleSettings>) {
    this.settings = { ...this.settings, ...p };
    await putSetting('google', this.settings);
    this.listeners.forEach((f) => f());
    return this.settings;
  },
  listeners: new Set<() => void>(),
  /** set by the basemap: Google tiles are actually showing (Google content must sit on a Google map) */
  tilesOk: false,
  /** Google content may be used right now (key present, mode on, online, Google map showing). */
  get active() { return !!this.settings.key && this.settings.on && this.tilesOk && (typeof navigator === 'undefined' || navigator.onLine !== false); },
};

class GoogleError extends Error {}
async function gfetch(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new GoogleError(`Google ${r.status}: ${j?.error?.message ?? r.statusText}`);
  return j;
}

// ---------------------------------------------------------------- Map Tiles API (2D)
export interface TileSession { session: string; expiry: number; tileWidth: number; imageFormat: string }

/** Dark map styling for night riding (same format as Google styled maps). */
const NIGHT_STYLES = [
  { stylers: [{ hue: '#1d2c4d' }] },
  { elementType: 'geometry', stylers: [{ color: '#1d2c4d' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1a3646' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#304a7d' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#98a5be' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2c6675' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1626' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#283d6a' }] },
  { featureType: 'landscape.natural', elementType: 'geometry', stylers: [{ color: '#023e58' }] },
];

export async function createTileSession(key: string, opts: { traffic: boolean; night: boolean; hiDpi: boolean }): Promise<TileSession> {
  const body: any = {
    mapType: 'roadmap', language: 'en-IN', region: 'IN',
    ...(opts.traffic ? { layerTypes: ['layerTraffic'] } : {}),
    ...(opts.hiDpi ? { scale: 'scaleFactor2x', highDpi: true } : {}),
    ...(opts.night ? { styles: NIGHT_STYLES } : {}),
  };
  const j = await gfetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { session: j.session, expiry: +j.expiry * 1000, tileWidth: j.tileWidth ?? 256, imageFormat: j.imageFormat ?? 'png' };
}

export const tileUrl = (key: string, s: TileSession) =>
  `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(s.session)}&key=${encodeURIComponent(key)}`;

/** Copyright text Google requires for the visible area. */
export async function viewportCopyright(key: string, s: TileSession, zoom: number, b: { n: number; s: number; e: number; w: number }) {
  const q = new URLSearchParams({ session: s.session, key, zoom: String(Math.round(zoom)), north: String(b.n), south: String(b.s), east: String(b.e), west: String(b.w) });
  const j = await gfetch(`https://tile.googleapis.com/tile/v1/viewport?${q}`);
  return (j.copyright as string) || 'Map data ©Google';
}

// ---------------------------------------------------------------- Routes API (two-wheeler, traffic-aware)
const MANEUVER: Record<string, TurnCode | null> = {
  TURN_SLIGHT_LEFT: 'slight-left', TURN_SHARP_LEFT: 'sharp-left', TURN_LEFT: 'left',
  TURN_SLIGHT_RIGHT: 'slight-right', TURN_SHARP_RIGHT: 'sharp-right', TURN_RIGHT: 'right',
  UTURN_LEFT: 'uturn', UTURN_RIGHT: 'uturn', STRAIGHT: null, DEPART: null, NAME_CHANGE: null, FERRY: null, FERRY_TRAIN: null,
  RAMP_LEFT: 'ramp-left', RAMP_RIGHT: 'ramp-right', MERGE: 'merge', FORK_LEFT: 'keep-left', FORK_RIGHT: 'keep-right',
  ROUNDABOUT_LEFT: 'roundabout', ROUNDABOUT_RIGHT: 'roundabout',
};

export interface GRoute { coords: LngLat[]; distM: number; durS: number; turns: Turn[] }

export async function googleRoute(key: string, from: LngLat, to: LngLat, signal?: AbortSignal, via: LngLat[] = []): Promise<GRoute> {
  gquota.take('routes2w'); // two-wheeler routing is Google's Enterprise level (7,000 free / month, India)
  const ll = (p: LngLat) => ({ location: { latLng: { latitude: p[1], longitude: p[0] } } });
  const j = await gfetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST', signal,
    headers: {
      'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.navigationInstruction',
    },
    body: JSON.stringify({
      origin: ll(from), destination: ll(to), travelMode: 'TWO_WHEELER', routingPreference: 'TRAFFIC_AWARE',
      // pass-through points force the route along a given path (used to price the rider's current route)
      ...(via.length ? { intermediates: via.map((p) => ({ ...ll(p), via: true })) } : {}),
      polylineQuality: 'HIGH_QUALITY', languageCode: 'en-IN', regionCode: 'IN', units: 'METRIC',
    }),
  });
  const r = j.routes?.[0];
  if (!r) throw new GoogleError('Google found no two-wheeler route');
  const coords: LngLat[] = [];
  const turns: Turn[] = [];
  for (const st of r.legs?.[0]?.steps ?? []) {
    const pts = polyline.decode(st.polyline?.encodedPolyline ?? '', 5).map(([lat, lng]) => [lng, lat] as LngLat);
    let startIdx = coords.length;
    pts.forEach((p, i) => {
      const last = coords[coords.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) { if (i === 0) startIdx = coords.length - 1; return; }
      coords.push(p);
    });
    const ni = st.navigationInstruction;
    const c = ni ? MANEUVER[ni.maneuver] : null;
    if (c) turns.push({ i: Math.max(0, startIdx), c, txt: ni.instructions?.split('\n')[0] });
  }
  return { coords, distM: r.distanceMeters ?? lineLength(coords), durS: parseInt(String(r.duration ?? '0').replace('s', '')) || 0, turns };
}

// ---------------------------------------------------------------- key diagnostics
export interface KeyTest { api: string; ok: boolean; message: string; fix?: string }

/** Turn Google's error (status + ErrorInfo reason) into a plain-language fix. */
function explain(j: any, httpStatus: number, apiName: string): { message: string; fix?: string } {
  const e = j?.error ?? {};
  const reason: string = (e.details ?? []).map((d: any) => d.reason).find(Boolean) ?? '';
  const msg: string = `${e.message ?? `HTTP ${httpStatus}`}${reason ? ` [${reason}]` : ''}`;
  const m = `${reason} ${msg}`;
  if (/SERVICE_DISABLED|has not been used|is disabled/i.test(m)) return { message: msg, fix: `Enable “${apiName}”: Google Cloud console → APIs & Services → Library → search “${apiName}” → Enable. Wait 2–5 minutes, then test again.` };
  if (/BILLING|billing/i.test(m)) return { message: msg, fix: 'Turn on billing for this project: Google Cloud console → Billing → Link a billing account. (Free monthly usage still applies; add a budget alert to stay at ₹0.)' };
  if (/REFERRER|referer|referrer/i.test(m)) return { message: msg, fix: `Website restriction doesn't match. Key → Application restrictions → Websites → add exactly: ${location.origin}/*  (and keep https://lonesoull.github.io/*). Changes take up to 5 minutes.` };
  if (/API_KEY_SERVICE_BLOCKED|are blocked|not authorized to use this API/i.test(m)) return { message: msg, fix: `Key → API restrictions → tick “${apiName}” (or choose “Don't restrict key” to test).` };
  if (/Permission denied on the service/i.test(m) || (httpStatus === 403 && /PERMISSION_DENIED/i.test(e.status ?? '') && !reason)) return { message: msg, fix: `This key isn't allowed to use ${apiName}. Most often: (1) it's a “Maps Demo Key” or the project has no billing account — Demo Keys don't include ${apiName}; link a billing account and create a normal API key; (2) ${apiName} isn't enabled — APIs & Services → Library → Enable; (3) the key's API restrictions don't tick ${apiName}.` };
  if (/API_KEY_INVALID|API key not valid|invalid/i.test(m)) return { message: msg, fix: 'The key text is wrong — copy it again from Credentials (no spaces) and paste.' };
  if (httpStatus === 429 || /quota|RATE_LIMIT|RESOURCE_EXHAUSTED/i.test(m)) return { message: msg, fix: 'Daily quota reached (or quota set to 0). Check Quotas for this API.' };
  return { message: msg };
}

async function probe(api: string, url: string, init: RequestInit): Promise<KeyTest> {
  try {
    const r = await fetch(url, init);
    const j = await r.json().catch(() => ({}));
    if (r.ok) return { api, ok: true, message: 'Working' };
    return { api, ok: false, ...explain(j, r.status, api) };
  } catch (e: any) {
    return { api, ok: false, message: e?.message ?? 'Network error', fix: 'No connection to Google (offline, firewall or VPN blocking googleapis.com).' };
  }
}

/** Check each Google API this app uses, separately. */
export async function testGoogleKey(key: string): Promise<KeyTest[]> {
  const json = { 'Content-Type': 'application/json' };
  return Promise.all([
    testMapsJs(key),
    probe('Routes API', 'https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST', headers: { ...json, 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.distanceMeters' },
      body: JSON.stringify({ origin: { location: { latLng: { latitude: 13.0827, longitude: 80.2707 } } }, destination: { location: { latLng: { latitude: 13.0674, longitude: 80.2376 } } }, travelMode: 'TWO_WHEELER' }),
    }),
    probe('Places API (New)', 'https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST', headers: { ...json, 'X-Goog-Api-Key': key }, body: JSON.stringify({ input: 'Chennai Central', includedRegionCodes: ['in'] }),
    }),
  ]);
}

const JS_ERRORS: Record<string, string> = {
  ApiNotActivatedMapError: 'Enable “Maps JavaScript API”: APIs & Services → Library → Maps JavaScript API → Enable. Wait 2–5 minutes.',
  RefererNotAllowedMapError: 'Website restriction doesn\'t match: Key → Application restrictions → Websites → add https://lonesoull.github.io/* (and http://localhost:* for local testing).',
  BillingNotEnabledMapError: 'Link a billing account to this project (Billing → Link a billing account). Free monthly usage still applies.',
  InvalidKeyMapError: 'The key text is wrong — copy it again from Credentials.',
  ApiTargetBlockedMapError: 'Key → API restrictions → tick “Maps JavaScript API”.',
  ApiProjectMapError: 'The key\'s project is missing the Maps JavaScript API or billing — enable both.',
  DeletedApiProjectMapError: 'This key belongs to a deleted project — create a new key.',
};

/** Load the Maps JavaScript API with this key and catch Google's named errors (it reports them in the console). */
async function testMapsJs(key: string): Promise<KeyTest> {
  const api = 'Maps JavaScript API';
  const { loadMapsJs, onAuthFailure } = await import('../map/googleJs');
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { seen.push(a.map(String).join(' ')); orig(...a); };
  let failed = false;
  const off = onAuthFailure(() => { failed = true; });
  try {
    await loadMapsJs(key);
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;left:-9999px;width:50px;height:50px';
    document.body.appendChild(div);
    new (window as any).google.maps.Map(div, { center: { lat: 13.08, lng: 80.27 }, zoom: 10, mapId: 'DEMO_MAP_ID' });
    await new Promise((r) => setTimeout(r, 4000));
    div.remove();
  } catch (e: any) {
    return { api, ok: false, message: e?.message ?? 'Failed to load', fix: 'Check the internet connection; if you changed the key, restart the app.' };
  } finally { console.error = orig; off(); }
  const name = Object.keys(JS_ERRORS).find((n) => seen.some((x) => x.includes(n)));
  if (name) return { api, ok: false, message: name, fix: JS_ERRORS[name] };
  if (failed) return { api, ok: false, message: 'Google rejected the key', fix: 'Enable “Maps JavaScript API”, link billing, and check the key\'s website and API restrictions.' };
  return { api, ok: true, message: 'Working' };
}
