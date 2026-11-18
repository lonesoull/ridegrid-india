import { engine } from '../core/engine';
import { app } from '../core/app';
import { haversine, type LngLat } from '../core/geo';
import { nav } from '../nav/navigator';
import { directionsTo, myLocation } from '../nav/directions';
import type { Approach } from '../nav/routeLine';
import { ui, toast } from './state';
import { mapCtl } from './App';

/**
 * Start live navigation / simulation the Google-Maps way: from where the rider is now,
 * by road to stop i, then on through the planned route.
 */
export async function startRide(mode: 'live' | 'sim', i: number, approach: Approach | null = null) {
  const s = engine.stops[i];
  if (!s) throw new Error('No such stop');
  const target: LngLat = [s.lng, s.lat];
  if (!approach) {
    try {
      const me = await myLocation();
      if (haversine(me, target) > 150) {
        const d = await directionsTo(i, me);
        approach = { coords: d.coords, turns: d.turns };
      }
    } catch (e: any) {
      if (mode === 'live') throw e;                 // live navigation needs GPS
      toast('No location — simulating from the stop itself');
    }
  }
  if (!approach && engine.stops.length - i < 2) throw new Error('You are already at the last stop.');
  await ensureMapped(i);
  await nav.start(mode, i, approach);
  if (approach) mapCtl?.setApproach(approach.coords);
  ui.set({ drawer: false, tapMode: 'off', selectedId: null, following: true });
  mapCtl?.startFollow(nav.pos);
}

/** Make sure the legs ahead (next 30) are road-mapped before riding them; maps them first if needed. */
async function ensureMapped(i: number) {
  const ahead = () => {
    const out: string[] = [];
    for (let k = i; k < Math.min(engine.stops.length - 1, i + 30); k++) { const l = engine.legAt(k); if (l && l.status !== 'ok') out.push(l.key); }
    return out;
  };
  let left = ahead();
  if (!left.length) return;
  if (!app.queue.autoRoute) app.queue.setAuto(true);
  left.forEach((k) => engine.priority.add(k));
  engine.retryErrors();
  app.queue.kick();
  const t0 = Date.now();
  while ((left = ahead()).length && Date.now() - t0 < 45000) {
    ui.set({ busy: `Mapping roads ahead first… ${left.length} segment(s) left` });
    await new Promise((r) => setTimeout(r, 500));
  }
  ui.set({ busy: null });
  if (left.length && !confirm(`${left.length} segment(s) ahead couldn't be road-mapped (offline or server busy). They would be followed as straight lines. Start anyway?`)) {
    throw new Error('Start cancelled — road mapping not finished');
  }
}
