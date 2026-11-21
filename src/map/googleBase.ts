import { google } from '../core/google';
import { toast, ui } from '../ui/state';
import { loadMapsJs, onAuthFailure, authFailed } from './googleJs';
import type { MapController } from './MapController';
import { mode } from '../core/mode';
import { dailyMap, buildDailyStyle } from '../daily/mapLayers';
import { gquota } from '../core/gquota';

/**
 * Chooses the basemap: Google's map (Maps JavaScript API, with live traffic that Google refreshes itself)
 * when Google mode is on and online; otherwise the offline-capable OpenStreetMap map.
 */
let unsubAuth: (() => void) | null = null;

export async function applyBase(map: MapController, _force = false) {
  const night = ui.get().night;
  const g = google.settings;
  // Google Maps is the base in both modes whenever it can be (key, online). Daily draws all its layers on top;
  // without Google (no key / offline / Google refused) Daily uses its own offline-capable map engine.
  const daily = mode.current === 'daily';
  // (cap reached → our map; the counter is only spent when a new Google map is created)
  const wanted = !!g.key && g.on && navigator.onLine !== false && !authFailed && (map.hasGoogleMap || gquota.can('mapLoad'));
  if (daily && !wanted) {
    google.tilesOk = false;
    try {
      const style = await buildDailyStyle(night);
      map.setStyleBase(`${JSON.stringify(dailyMap.settings)}|${night}`, style);
      return;
    } catch (e: any) { toast(`Map style failed (${e?.message || e}) — using the standard map`, 'error'); map.setOsmBase(night); return; }
  }
  if (!wanted) { google.tilesOk = false; map.setOsmBase(night); return; }
  try {
    await loadMapsJs(g.key, daily ? dailyMap.settings.labelLang : 'en');
    if (authFailed) throw new Error('Google rejected this key for the Maps JavaScript API (Settings → Google Maps → “Test key” shows the fix)');
    map.onGoogleMapLoad ??= () => { try { gquota.take('mapLoad'); } catch { /* counted at the cap */ } };
    unsubAuth ??= onAuthFailure(() => {
      google.tilesOk = false;
      void applyBase(map, true);
      toast('Google rejected the key for the Maps JavaScript API — using the OpenStreetMap map. Settings → Google Maps → “Test key” shows the fix.', 'error');
      ui.set({ gtick: ui.get().gtick + 1 });
    });
    if (daily) {
      const d = dailyMap.settings;
      const style = await buildDailyStyle(night, true);
      map.setGoogleJsBase({ night, traffic: g.traffic, mapId: g.mapId, mapType: d.gType, transit: d.gTransit, bike: d.gBike, drive: true,
        onHold: (x, y) => map.holdDrag?.start(x, y) ?? false,
        onHoldMove: (x, y) => map.holdDrag?.move(x, y),
        onHoldEnd: (x, y) => map.holdDrag?.end(x, y),
        onPlaceTap: (id, p) => ui.set({ place: { id: `g:${id}`, name: 'Loading…', address: '', provider: 'google', p: undefined }, selectedId: null }) }, { id: `${JSON.stringify(d)}|${night}`, style });
    } else map.setGoogleJsBase({ night, traffic: g.traffic, mapId: g.mapId, mapType: 'roadmap', transit: false, bike: false, drive: true,
        onHold: (x, y) => map.holdDrag?.start(x, y) ?? false,
        onHoldMove: (x, y) => map.holdDrag?.move(x, y),
        onHoldEnd: (x, y) => map.holdDrag?.end(x, y),
        onPlaceTap: (id) => ui.set({ place: { id: `g:${id}`, name: 'Loading…', address: '', provider: 'google', p: undefined }, selectedId: null }) });
    google.tilesOk = true;
  } catch (e: any) {
    google.tilesOk = false;
    toast(`${e?.message || e} — using the OpenStreetMap map instead.`, 'error');
    if (daily) { try { map.setStyleBase(`${JSON.stringify(dailyMap.settings)}|${night}`, await buildDailyStyle(night)); return; } catch { /* below */ } }
    map.setOsmBase(night);
  }
}

/** Traffic is refreshed by Google itself now; nothing to retune. */
export function retuneTraffic(_map: MapController) {}
