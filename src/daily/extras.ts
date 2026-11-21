import { isTyping } from '../ui/typing';
import { getSetting, putSetting } from '../core/db';
import { engine } from '../core/engine';
import { mode } from '../core/mode';
import { haversine, fmtKm, type LngLat } from '../core/geo';
import { turnText } from '../core/turns';
import { nav } from '../nav/navigator';
import { say } from '../nav/audio';
import { watchGps } from '../nav/gps';
import { placeName } from '../nav/logbook';
import { ui, toast } from '../ui/state';
import { mapCtl } from '../ui/App';
import { rideDevice } from './rideDevice';
import { recorder } from './recorder';
import { markers } from './markers';
import { handoff } from '../nav/handoff';
import { googleReady, addressAt } from './gfeatures';
import type { CoordFormat } from './coords';
import { routing } from '../core/router';
import { roadWidth } from '../map/MapController';
import { dailyNav } from './dailyNav';
routing.avoidBorders = () => mode.current === 'daily' && extras.s.avoidBorders;

/** Daily extras from OsmAnd: handlebar buttons, turn notification, wake screen, light-sensor night,
 *  auto-record, "where am I", coordinate format, recent destinations, avoid borders, text size. */
export type BtnAction = 'zoomIn' | 'zoomOut' | 'recenter' | 'repeat' | 'whereAmI' | 'favourite' | 'record' | 'googleNext' | 'voice';
export const BTN_LABEL: Record<BtnAction, string> = { zoomIn: 'Zoom in', zoomOut: 'Zoom out', recenter: 'Re-centre on me', repeat: 'Repeat the last instruction', whereAmI: 'Where am I?', favourite: 'Save this spot as favourite', record: 'Start / stop track recording', googleNext: 'Next 10 in Google Maps', voice: 'Voice on / off' };
export interface Extras {
  keys: Record<string, BtnAction>;   // keyboard key / media button → action
  notify: boolean; wakeScreen: boolean; lightNight: boolean; autoRecord: boolean;
  coordFormat: CoordFormat; avoidBorders: boolean; textScale: number;
  routeColor: string; routeWidth: number; showAvoided: boolean;
}
export const DEFAULT_EXTRAS: Extras = {
  keys: { ArrowUp: 'zoomIn', ArrowDown: 'zoomOut', Enter: 'recenter', MediaPlayPause: 'repeat', MediaTrackNext: 'zoomIn', MediaTrackPrevious: 'zoomOut', ' ': 'whereAmI', f: 'favourite', r: 'record', g: 'googleNext' },
  notify: true, wakeScreen: false, lightNight: false, autoRecord: false, coordFormat: 'dec', avoidBorders: false, textScale: 1,
  routeColor: '#1e90ff', routeWidth: 1, showAvoided: true,
};
export const extras = {
  s: structuredClone(DEFAULT_EXTRAS),
  listeners: new Set<() => void>(),
  async load() { this.s = { ...DEFAULT_EXTRAS, ...(await getSetting<Partial<Extras>>('dailyExtras', {})) }; },
  async save(p: Partial<Extras>) {
    const replan = p.avoidBorders !== undefined && p.avoidBorders !== this.s.avoidBorders;
    this.s = { ...this.s, ...p }; await putSetting('dailyExtras', this.s); this.listeners.forEach((f) => f());
    if (replan && engine.trip?.kind === 'daily') await engine.loadTrip(engine.trip.id);
  },
};
const daily = () => mode.current === 'daily';
/** Latest phone readings (Android app): light, GPS satellites used / seen, signal strength. */
export const deviceStatus = { v: null as null | { lux: number; satsUsed: number; satsSeen: number; cn0: number } };
let lastSaid = '';

/** "Where am I?" — road / area, and the distance to the next stop. */
export async function whereAmI() {
  const p = nav.pos ?? (mapCtl ? [mapCtl.map.getCenter().lng, mapCtl.map.getCenter().lat] as LngLat : null);
  if (!p) return;
  let place: string | null | undefined = null;
  try { place = googleReady() ? await addressAt(p) : await placeName(p); } catch { place = await placeName(p).catch(() => undefined); }
  const next = nav.mode !== 'off' && nav.line && nav.next < engine.stops.length ? `. ${fmtKm(nav.distToNext)} to stop ${nav.next + 1}` : '';
  const msg = `You are at ${place ?? `${p[1].toFixed(4)}, ${p[0].toFixed(4)}`}${next}`;
  toast(msg); say(msg);
}

function act(a: BtnAction) {
  const m = mapCtl?.map;
  switch (a) {
    case 'zoomIn': m?.zoomIn(); break;
    case 'zoomOut': m?.zoomOut(); break;
    case 'recenter': ui.set({ following: true }); mapCtl?.startFollow(nav.pos); break;
    case 'repeat': { const t = nav.nextTurn; const txt = t ? `In ${fmtKm(t.dist)}, ${turnText(t)}` : lastSaid || 'No instruction yet'; say(txt); break; }
    case 'whereAmI': void whereAmI(); break;
    case 'favourite': if (nav.pos) void markers.put({ kind: 'fav', name: `Spot ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`, p: nav.pos, group: 'Saved on the ride' }).then(() => { say('Saved'); toast('Spot saved to favourites'); }); break;
    case 'record': void (recorder.on ? recorder.stop() : recorder.start()).then(() => say(recorder.on ? 'Recording' : 'Recording saved')); break;
    case 'googleNext': handoff.open(); break;
    case 'voice': void nav.setSettings({ voice: !nav.settings.voice }).then(() => toast(nav.settings.voice ? 'Voice on' : 'Voice off')); break;
  }
}

export function startExtras() {
  // ---- handlebar / Bluetooth remote buttons (they arrive as keys or media buttons)
  window.addEventListener('keydown', (e) => {
    if (!daily() || isTyping(e)) return;
    const a = extras.s.keys[e.key] ?? extras.s.keys[e.key.toLowerCase()];
    if (a) { e.preventDefault(); act(a); }
  });
  const ms = (navigator as any).mediaSession;
  if (ms) {
    for (const [ev, key] of [['play', 'MediaPlayPause'], ['pause', 'MediaPlayPause'], ['nexttrack', 'MediaTrackNext'], ['previoustrack', 'MediaTrackPrevious']] as const) {
      try { ms.setActionHandler(ev, () => { if (daily()) { const a = extras.s.keys[key]; if (a) act(a); } }); } catch { /* unsupported */ }
    }
  }
  // ---- next-turn notification + wake the screen before turns
  let lastNote = '', woke = -1;
  nav.subscribe(() => {
    if (!daily() || nav.mode !== 'live') { if (lastNote) { lastNote = ''; void rideDevice.clear(); } return; }
    const t = nav.nextTurn;
    const title = t ? `${t.dist < 1000 ? Math.round(t.dist / 10) * 10 + ' m' : (t.dist / 1000).toFixed(1) + ' km'} · ${turnText(t)}` : 'Continue on route';
    const text = `${fmtKm(nav.remaining)} to go${engine.stops[nav.next]?.name ? ` · next: ${engine.stops[nav.next].name}` : ''}`;
    if (t) lastSaid = `In ${fmtKm(t.dist)}, ${turnText(t)}`;
    if (extras.s.notify && title + text !== lastNote) { lastNote = title + text; void rideDevice.notify(title, text); }
    if (extras.s.wakeScreen && t && t.dist < Math.max(150, nav.speedMps * 15) && woke !== t.s) { woke = t.s; void rideDevice.wake(15000); }
  });
  // ---- night map from the light sensor (tunnels, heavy cloud)
  let darkSince = 0, brightSince = 0;
  setInterval(async () => {
    if (!daily()) return;
    const st = await rideDevice.status();
    if (st) deviceStatus.v = st;
    if (!st || !extras.s.lightNight || st.lux < 0) return;
    const night = ui.get().night;
    if (st.lux < 10) { brightSince = 0; darkSince ||= Date.now(); if (!night && Date.now() - darkSince > 5000) ui.set({ night: true }); }
    else if (st.lux > 60) { darkSince = 0; brightSince ||= Date.now(); if (night && Date.now() - brightSince > 10000) ui.set({ night: false }); }
  }, 2000);
  // ---- auto-start / stop track recording when riding / parked
  let fast = 0, still = 0, stopGps: null | (() => void) = null;
  const auto = async () => {
    if (daily() && extras.s.autoRecord && !stopGps) {
      stopGps = await watchGps((f) => {
        const kmh = (f.speed ?? 0) * 3.6;
        if (nav.mode === 'live') return; // navigation logs the ride itself
        if (kmh > 12) { fast++; still = 0; if (fast >= 3 && !recorder.on) void recorder.start().then(() => toast('Riding — track recording started')); }
        else if (kmh < 2) { still = still || f.time; fast = 0; if (recorder.on && f.time - still > 15 * 60000) void recorder.stop().then(() => toast('Parked — track saved')); }
      }, () => {});
    } else if ((!daily() || !extras.s.autoRecord) && stopGps) { stopGps(); stopGps = null; }
  };
  extras.listeners.add(() => void auto());
  void auto();
  // ---- bigger text for RideGrid's own map labels
  let lastScale = extras.s.textScale;
  const applyText = () => {
    try { localStorage.setItem('ridegrid.daily.textScale', JSON.stringify(extras.s.textScale)); } catch { /* ignore */ }
    if (lastScale !== extras.s.textScale && mapCtl && daily()) { lastScale = extras.s.textScale; void import('../map/googleBase').then((g) => g.applyBase(mapCtl!, true)); }
  };
  extras.listeners.add(applyText); applyText();
}

// ---------------------------------------------------------------- recent destinations
const RK = 'ridegrid.daily.recentDest';
export interface RecentDest { name: string; p: LngLat; at: number }
export function recentDestinations(): RecentDest[] { try { return JSON.parse(localStorage.getItem(RK) ?? '[]'); } catch { return []; } }
export function rememberDestination(name: string, p: LngLat) {
  try { localStorage.setItem(RK, JSON.stringify([{ name, p, at: Date.now() }, ...recentDestinations().filter((d) => haversine(d.p, p) > 30)].slice(0, 20))); } catch { /* ignore */ }
}

// ---------------------------------------------------------------- route line look + avoided roads on the map (Daily only)
export function installRouteStyle(ctl: import('../map/MapController').MapController) {
  const apply = (m: import('maplibre-gl').Map) => {
    const d = daily();
    const k = d ? extras.s.routeWidth : 1;
    if (m.getLayer('rg-route-line')) { m.setPaintProperty('rg-route-line', 'line-color', d ? extras.s.routeColor : '#1e90ff'); m.setPaintProperty('rg-route-line', 'line-width', roadWidth(7, 3, k)); }
    if (m.getLayer('rg-route-casing')) m.setPaintProperty('rg-route-casing', 'line-width', roadWidth(10, 5, k));
    // the way to your first stop: same solid blue as the route while riding (Google style); Expedition keeps its dashed orange detour line
    if (m.getLayer('rg-approach')) {
      m.setPaintProperty('rg-approach', 'line-color', d ? extras.s.routeColor : '#f97316');
      m.setPaintProperty('rg-approach', 'line-dasharray', d ? undefined : [1.5, 1]);
      m.setPaintProperty('rg-approach', 'line-width', d ? roadWidth(7, 3, k) : ['interpolate', ['linear'], ['zoom'], 6, 1.6, 14, 4.5]);
    }
    const data = { type: 'FeatureCollection' as const, features: d && extras.s.showAvoided ? dailyNav.s.avoided.map((a) => ({ type: 'Feature' as const, properties: { name: a.name }, geometry: { type: 'LineString' as const, coordinates: a.coords } })) : [] };
    const src = m.getSource('d-avoided') as import('maplibre-gl').GeoJSONSource | undefined;
    if (src) src.setData(data);
    else {
      m.addSource('d-avoided', { type: 'geojson', data });
      m.addLayer({ id: 'd-avoided', type: 'line', source: 'd-avoided', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#e11d48', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3, 16, 9], 'line-opacity': 0.7, 'line-dasharray': [1, 0.8] } });
      m.addLayer({ id: 'd-avoided-x', type: 'symbol', source: 'd-avoided', layout: { 'symbol-placement': 'line', 'symbol-spacing': 120, 'text-field': '⛔', 'text-size': 14, 'text-font': ['Noto Sans Regular'] } });
    }
  };
  ctl.styleHooks.add((m) => { try { apply(m); } catch (e) { (window as any).__rgStyleErr = String(e); console.warn('route style', e); } });
  const again = () => { try { if (ctl.map.getLayer('rg-route-line')) apply(ctl.map); } catch (e) { console.warn('route style', e); } };
  extras.listeners.add(again); dailyNav.listeners.add(again);
  // switching between Expedition and Daily: restyle (the map style isn't always rebuilt)
  new MutationObserver(again).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
  again();
}
