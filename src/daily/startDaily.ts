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

/** Daily-mode runtime hooks: road alerts / speed sign while riding, auto-zoom by speed. */
export function startDaily(ctl: MapController) {
  let last = '';
  let buzzed = -1;
  nav.subscribe(() => {
    if (mode.current !== 'daily' || nav.mode === 'off' || !nav.pos) {
      if (roadInfo.ahead || roadInfo.limit || roadInfo.road) { roadInfo.ahead = null; roadInfo.limit = null; roadInfo.road = ''; roadInfo.emit(); }
      return;
    }
    const k = `${nav.pos[0].toFixed(5)},${nav.pos[1].toFixed(5)}`;
    if (k === last) return;
    last = k;
    updateRoadInfo(nav.pos, nav.heading, nav.mode === 'sim' ? nav.settings.simKmh / 3.6 : nav.speedMps);
    // vibrate shortly before each turn
    const t = nav.nextTurn;
    if (t && t.dist < 60 && buzzed !== t.s) { buzzed = t.s; access.buzz(t.c.includes('left') ? [300] : [100, 80, 100]); }
  });
  installTrackLayer(ctl);
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
