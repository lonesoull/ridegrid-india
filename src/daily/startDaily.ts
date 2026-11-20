import type { MapController } from '../map/MapController';
import { nav } from '../nav/navigator';
import { mode } from '../core/mode';
import { dailyNav } from './dailyNav';
import { updateRoadInfo, roadInfo } from './roadAlerts';
import { installTrackLayer } from './trackTools';
import { markers } from './markers';
import { say } from '../nav/audio';
import { toast } from '../ui/state';
import { access } from './access';
import { announceAhead } from './aheadVoice';
import { pushToCar } from './carBridge';

/** Daily-mode runtime hooks: road alerts / speed sign while riding, auto-zoom by speed. */
export function startDaily(ctl: MapController) {
  let last = '';
  let buzzed = -1;
  nav.subscribe(() => {
    if (mode.current === 'daily') pushToCar();
    if (mode.current !== 'daily' || nav.mode === 'off' || !nav.pos) {
      if (roadInfo.ahead || roadInfo.limit || roadInfo.road) { roadInfo.ahead = null; roadInfo.limit = null; roadInfo.road = ''; roadInfo.emit(); }
      return;
    }
    const k = `${nav.pos[0].toFixed(5)},${nav.pos[1].toFixed(5)}`;
    if (k === last) return;
    last = k;
    updateRoadInfo(nav.pos, nav.heading, nav.mode === 'sim' ? nav.settings.simKmh / 3.6 : nav.speedMps);
    void announceAhead().catch(() => {});
    // vibrate shortly before each turn
    const t = nav.nextTurn;
    if (t && t.dist < 60 && buzzed !== t.s) { buzzed = t.s; access.buzz(t.c.includes('left') ? [300] : [100, 80, 100]); }
  });
  installTrackLayer(ctl);
  // once a day: tell the rider when newer offline maps / search data are published
  setTimeout(() => void checkUpdates(), 15000);
  // parked-bike reminder
  let warned = '';
  setInterval(() => {
    const p = markers.parking();
    if (!p?.until || Date.now() < p.until || warned === p.id + p.until) return;
    warned = p.id + p.until;
    toast('⏱ Parking time is up', 'error');
    say('Parking time is up');
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification('RideGrid', { body: 'Parking time is up' }); } catch { /* ignore */ }
  }, 30000);
  ctl.followZoom = () => {
    if (mode.current !== 'daily' || !dailyNav.s.autoZoom) return null;
    const kmh = (nav.mode === 'sim' ? nav.settings.simKmh * Math.min(nav.mult, 2) : nav.speedMps * 3.6);
    return kmh < 15 ? 17 : kmh < 35 ? 16.3 : kmh < 60 ? 15.6 : kmh < 85 ? 15 : 14.5;
  };
}

async function checkUpdates() {
  if (mode.current !== 'daily' || !navigator.onLine) return;
  try { if (Date.now() - +(localStorage.getItem('ridegrid.updcheck') ?? 0) < 86400000) return; localStorage.setItem('ridegrid.updcheck', String(Date.now())); } catch { /* ignore */ }
  const { offlineMaps } = await import('./offlineMap');
  const { offlineSearch } = await import('./offlineSearch');
  const { mapServer } = await import('./DailyMapTab');
  const stale: string[] = [];
  for (const z of await offlineMaps.installed()) { const m = await offlineMaps.meta(z.zone, mapServer()); if (m?.generated && m.generated !== z.generated) stale.push(`${z.zone} map`); }
  for (const z of await offlineSearch.installed()) {
    const m = await fetch(`${import.meta.env.BASE_URL}poi/${z.zone}.poi.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (m?.generated && m.generated !== z.generated) stale.push(`${z.zone} search`);
  }
  if (stale.length) toast(`Map updates available (${stale.length}) — Map tab → Offline maps → Update`);
}
