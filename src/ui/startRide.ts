import { engine } from '../core/engine';
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
  await nav.start(mode, i, approach);
  if (approach) mapCtl?.setApproach(approach.coords);
  ui.set({ drawer: false, tapMode: 'off', selectedId: null, following: true });
  mapCtl?.startFollow(nav.pos);
}
