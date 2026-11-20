import type { LngLat } from '../core/geo';

/** OpenStreetMap contributions (OsmAnd "OSM editing"): map notes (no account needed) and the web editor. */
export async function createOsmNote(p: LngLat, text: string) {
  const u = `https://api.openstreetmap.org/api/0.6/notes.json?lat=${p[1].toFixed(6)}&lon=${p[0].toFixed(6)}&text=${encodeURIComponent(text + '\n\n#RideGrid')}`;
  const r = await fetch(u, { method: 'POST' });
  if (!r.ok) throw new Error(`OpenStreetMap refused the note (${r.status})`);
  const j = await r.json();
  return j?.properties?.id as number | undefined;
}
export async function osmNotesNear(p: LngLat, km = 2) {
  const d = km / 111;
  const u = `https://api.openstreetmap.org/api/0.6/notes.json?bbox=${(p[0] - d).toFixed(4)},${(p[1] - d).toFixed(4)},${(p[0] + d).toFixed(4)},${(p[1] + d).toFixed(4)}&limit=30&closed=0`;
  const j = await fetch(u).then((r) => r.json()).catch(() => null);
  return (j?.features ?? []).map((f: any) => ({ id: f.properties.id, p: f.geometry.coordinates as LngLat, text: f.properties.comments?.[0]?.text ?? '', url: `https://www.openstreetmap.org/note/${f.properties.id}` }));
}
export const osmEditUrl = (p: LngLat, z = 18) => `https://www.openstreetmap.org/edit#map=${z}/${p[1].toFixed(5)}/${p[0].toFixed(5)}`;

// ---------------------------------------------------------------- OpenStreetMap login (OAuth 2 + PKCE, no server needed) and editing
const OSM = 'https://www.openstreetmap.org', API = 'https://api.openstreetmap.org/api/0.6';
const K = { client: 'ridegrid.osm.client', token: 'ridegrid.osm.token', verifier: 'ridegrid.osm.verifier', user: 'ridegrid.osm.user' };
const ls = { get: (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } }, set: (k: string, v: string) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch { /* ignore */ } } };
const redirectUri = () => location.origin + location.pathname;
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const osmAuth = {
  get clientId() { return ls.get(K.client); },
  set clientId(v: string) { ls.set(K.client, v.trim()); },
  get loggedIn() { return !!ls.get(K.token); },
  get user() { return ls.get(K.user); },
  redirectUri,
  async login() {
    if (!this.clientId) throw new Error('Add your OpenStreetMap app Client ID first');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    ls.set(K.verifier, verifier);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    location.href = `${OSM}/oauth2/authorize?${new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'read_prefs write_api write_notes', code_challenge: challenge, code_challenge_method: 'S256', state: 'osm' })}`;
  },
  /** Called once at start: finishes the login when OpenStreetMap sends the rider back with ?code=… */
  async finish(): Promise<boolean> {
    const q = new URLSearchParams(location.search);
    if (q.get('state') !== 'osm' || !q.get('code')) return false;
    history.replaceState(null, '', redirectUri() + location.hash);
    const r = await fetch(`${OSM}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code')!, redirect_uri: redirectUri(), client_id: this.clientId, code_verifier: ls.get(K.verifier) }) });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token) throw new Error('OpenStreetMap login failed');
    ls.set(K.token, j.access_token); ls.set(K.verifier, '');
    const me = await fetch(`${API}/user/details.json`, { headers: { Authorization: `Bearer ${j.access_token}` } }).then((x) => x.json()).catch(() => null);
    ls.set(K.user, me?.user?.display_name ?? 'OSM user');
    return true;
  },
  logout() { ls.set(K.token, ''); ls.set(K.user, ''); },
};

async function api(path: string, method = 'GET', body?: string) {
  const r = await fetch(API + path, { method, headers: { Authorization: `Bearer ${ls.get(K.token)}`, ...(body ? { 'Content-Type': 'text/xml' } : {}) }, body });
  if (r.status === 401) { osmAuth.logout(); throw new Error('OpenStreetMap login expired — log in again'); }
  if (!r.ok) throw new Error(`OpenStreetMap: ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.text();
}
const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tagsXml = (t: Record<string, string>) => Object.entries(t).filter(([, v]) => v !== '').map(([k, v]) => `<tag k="${x(k)}" v="${x(v)}"/>`).join('');

async function withChangeset<T>(comment: string, f: (cs: string) => Promise<T>): Promise<T> {
  const cs = (await api('/changeset/create', 'PUT', `<osm><changeset><tag k="created_by" v="RideGrid"/><tag k="comment" v="${x(comment)}"/><tag k="hashtags" v="#RideGrid"/></changeset></osm>`)).trim();
  try { return await f(cs); } finally { await api(`/changeset/${cs}/close`, 'PUT').catch(() => {}); }
}

/** Add a new place (petrol pump, mechanic, dhaba…) as a point. */
export async function osmAddPlace(p: LngLat, tags: Record<string, string>) {
  return withChangeset(`Add ${tags.name ?? 'place'} (from a ride)`, async (cs) =>
    (await api('/node/create', 'PUT', `<osm><node changeset="${cs}" lat="${p[1].toFixed(7)}" lon="${p[0].toFixed(7)}">${tagsXml(tags)}</node></osm>`)).trim());
}

export interface OsmPlace { id: number; p: LngLat; tags: Record<string, string>; version: number }
/** Named / tagged points within ~150 m, to correct. */
export async function osmPlacesNear(p: LngLat, m = 150): Promise<OsmPlace[]> {
  const dx = m / (111320 * Math.cos((p[1] * Math.PI) / 180)), dy = m / 110540;
  const j = JSON.parse(await (await fetch(`${API}/map.json?bbox=${p[0] - dx},${p[1] - dy},${p[0] + dx},${p[1] + dy}`)).text());
  return (j.elements ?? []).filter((e: any) => e.type === 'node' && e.tags && (e.tags.name || e.tags.amenity || e.tags.shop))
    .map((e: any) => ({ id: e.id, p: [e.lon, e.lat] as LngLat, tags: e.tags, version: e.version }));
}
/** Change some tags of a point (name, hours, phone, closed…); empty value removes the tag. */
export async function osmEditPlace(pl: OsmPlace, change: Record<string, string>) {
  const tags = { ...pl.tags, ...change };
  for (const k of Object.keys(tags)) if (tags[k] === '') delete tags[k];
  return withChangeset(`Update ${pl.tags.name ?? 'place'} (from a ride)`, (cs) =>
    api(`/node/${pl.id}`, 'PUT', `<osm><node id="${pl.id}" version="${pl.version}" changeset="${cs}" lat="${pl.p[1]}" lon="${pl.p[0]}">${tagsXml(tags)}</node></osm>`));
}
export const OSM_KINDS: Record<string, Record<string, string>> = {
  'Petrol pump': { amenity: 'fuel' }, 'EV charging': { amenity: 'charging_station' }, 'Bike mechanic': { shop: 'motorcycle_repair' }, 'Tyre / puncture shop': { shop: 'tyres' },
  'Dhaba / restaurant': { amenity: 'restaurant' }, 'Tea stall / café': { amenity: 'cafe' }, 'Toilets': { amenity: 'toilets' }, 'ATM': { amenity: 'atm' },
  'Hotel / lodge': { tourism: 'hotel' }, 'Homestay': { tourism: 'guest_house' }, 'Viewpoint': { tourism: 'viewpoint' }, 'Drinking water': { amenity: 'drinking_water' },
};
