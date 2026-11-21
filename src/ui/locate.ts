import { live, startLiveLocation } from '../nav/liveLocation';
import { nav } from '../nav/navigator';
import type { MapController } from '../map/MapController';
import { ui, toast } from './state';

/**
 * The "my location" button, like Google Maps: first tap centres on you and keeps following,
 * second tap turns the map with your compass, a third goes back to north-up. Dragging the map stops following.
 */
export type LocMode = 'off' | 'follow' | 'compass';
let ctl: MapController | null = null;
let lastDraw = 0;

export function startLocate(c: MapController) {
  ctl = c;
  startLiveLocation();
  live.subscribe((f) => {
    if (!f || !ctl || nav.mode !== 'off') return;
    const now = Date.now();
    if (now - lastDraw < 150) return; // ~6 updates a second is plenty
    lastDraw = now;
    ctl.showMe(f.p, false, f.acc, f.heading);
    const m = ui.get().locMode;
    if (m !== 'off') ctl.map.easeTo({ center: f.p, ...(m === 'compass' && f.heading != null ? { bearing: f.heading } : {}), duration: 300 });
  });
  c.map.on('dragstart', () => { if (ui.get().locMode !== 'off') ui.set({ locMode: 'off' }); });
}

export async function locateMe() {
  if (!ctl) return;
  if (nav.mode !== 'off') { ui.set({ following: true }); ctl.startFollow(nav.pos); return; }
  const m = ui.get().locMode;
  if (m === 'follow' && live.pos) { ui.set({ locMode: 'compass' }); if (live.fix?.heading == null) toast('Turn the phone to use the compass'); return; }
  if (m === 'compass') { ui.set({ locMode: 'follow' }); ctl.map.easeTo({ bearing: 0, pitch: 0, duration: 400 }); return; }
  if (!live.pos) toast('Finding you…');
  try {
    const f = await live.next();
    ctl.showMe(f.p, false, f.acc, f.heading);
    ctl.map.flyTo({ center: f.p, zoom: Math.max(ctl.map.getZoom(), 16), duration: 700 });
    ui.set({ locMode: 'follow' });
  } catch (e: any) { toast(e.message, 'error'); }
}
