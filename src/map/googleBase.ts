import { google, createTileSession, tileUrl, type TileSession } from '../core/google';
import { toast, ui } from '../ui/state';
import type { MapController } from './MapController';

/**
 * Chooses the basemap: Google tiles (+ live traffic) when Google mode is on and online,
 * otherwise the offline-capable OpenStreetMap map. Traffic tiles are refreshed by renewing the
 * session every 10 minutes (new token → fresh tiles), only while traffic is shown.
 */
let session: TileSession | null = null;
let sessionKey = '';
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const REFRESH_MS = 10 * 60 * 1000;

export async function applyBase(map: MapController, forceNew = false) {
  const night = ui.get().night;
  const g = google.settings;
  if (!google.active) {
    stopRefresh();
    map.setOsmBase(night);
    return;
  }
  const want = `${g.traffic ? 't' : 'n'}${night ? 'd' : 'l'}`;
  try {
    if (forceNew || !session || sessionKey !== want || session.expiry - Date.now() < 86400000) {
      session = await createTileSession(g.key, { traffic: g.traffic, night, hiDpi: (window.devicePixelRatio ?? 1) > 1.5 });
      sessionKey = want;
    }
    map.setGoogleBase(`${want}:${session.session.slice(-12)}`, tileUrl(g.key, session), night);
    if (g.traffic && !refreshTimer) refreshTimer = setInterval(() => void applyBase(map, true), REFRESH_MS);
    if (!g.traffic) stopRefresh();
  } catch (e: any) {
    toast(`${e?.message || e} — using the OpenStreetMap map instead. Check the key's API restrictions (Map Tiles API).`, 'error');
    stopRefresh();
    map.setOsmBase(night);
  }
}

function stopRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }
export const currentSession = () => session;
