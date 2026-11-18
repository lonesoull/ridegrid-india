import { google } from '../core/google';
import { toast, ui } from '../ui/state';
import { loadMapsJs, onAuthFailure, authFailed } from './googleJs';
import type { MapController } from './MapController';

/**
 * Chooses the basemap: Google's map (Maps JavaScript API, with live traffic that Google refreshes itself)
 * when Google mode is on and online; otherwise the offline-capable OpenStreetMap map.
 */
let unsubAuth: (() => void) | null = null;

export async function applyBase(map: MapController, _force = false) {
  const night = ui.get().night;
  const g = google.settings;
  const wanted = !!g.key && g.on && navigator.onLine !== false;
  if (!wanted) { google.tilesOk = false; map.setOsmBase(night); return; }
  try {
    await loadMapsJs(g.key);
    if (authFailed) throw new Error('Google rejected this key for the Maps JavaScript API (Tools → Google Maps mode → “Test key” shows the fix)');
    unsubAuth ??= onAuthFailure(() => {
      google.tilesOk = false;
      map.setOsmBase(ui.get().night);
      toast('Google rejected the key for the Maps JavaScript API — using the OpenStreetMap map. Tools → Google Maps mode → “Test key” shows the fix.', 'error');
      ui.set({ gtick: ui.get().gtick + 1 });
    });
    map.setGoogleJsBase({ night, traffic: g.traffic, mapId: g.mapId });
    google.tilesOk = true;
  } catch (e: any) {
    google.tilesOk = false;
    toast(`${e?.message || e} — using the OpenStreetMap map instead.`, 'error');
    map.setOsmBase(night);
  }
}

/** Traffic is refreshed by Google itself now; nothing to retune. */
export function retuneTraffic(_map: MapController) {}
