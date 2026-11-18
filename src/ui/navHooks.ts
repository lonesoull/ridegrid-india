import { useSyncExternalStore } from 'react';
import { nav } from '../nav/navigator';
import { engine } from '../core/engine';
import { mapCtl } from './App';

/** Re-render on navigator changes, at most once per animation frame. */
const subs = new Set<() => void>();
let raf = 0;
let wasOn = false;
let lastApproach: unknown = null;
nav.subscribe(() => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    subs.forEach((f) => f());
    // draw puck / next stop / ridden track on the map
    if (nav.mode === 'off') {
      mapCtl?.setNav(null);
      if (wasOn) { mapCtl?.setApproach(null); wasOn = false; lastApproach = null; }
      return;
    }
    wasOn = true;
    if (nav.approach !== lastApproach) { lastApproach = nav.approach; mapCtl?.setApproach(nav.approach?.coords ?? null); }
    const st = engine.stops[nav.next];
    mapCtl?.setNav({ pos: nav.pos, heading: nav.heading, accuracy: nav.accuracy, next: st ? [st.lng, st.lat] : null, track: nav.track }, nav.mode === 'sim');
  });
});
export function useNav() {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => nav.version);
}
