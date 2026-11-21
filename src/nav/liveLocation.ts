import type { LngLat } from '../core/geo';

/**
 * Always-on "blue dot" (like Google Maps): the phone's location and compass while the app is open.
 * Stops when the app goes to the background (navigation and track recording use their own GPS stream).
 */
export interface LiveFix { p: LngLat; acc: number; heading: number | null; speed: number | null; at: number }
type L = (f: LiveFix | null) => void;

let watch: number | null = null;
let compass: number | null = null;
const listeners = new Set<L>();
export const live = {
  fix: null as LiveFix | null,
  error: '' as string,
  denied: false,
  get pos(): LngLat | null { return this.fix && Date.now() - this.fix.at < 120000 ? this.fix.p : null; },
  subscribe(f: L) { listeners.add(f); return () => { listeners.delete(f); }; },
  emit() { listeners.forEach((f) => f(this.fix)); },
  start() {
    if (watch !== null || !navigator.geolocation) return;
    watch = navigator.geolocation.watchPosition((p) => {
      this.error = ''; this.denied = false;
      const moving = (p.coords.speed ?? 0) > 1.5;
      this.fix = { p: [p.coords.longitude, p.coords.latitude], acc: p.coords.accuracy, speed: p.coords.speed,
        heading: moving && p.coords.heading != null && !Number.isNaN(p.coords.heading) ? p.coords.heading : compass, at: Date.now() };
      this.emit();
    }, (e) => {
      this.denied = e.code === 1;
      this.error = e.code === 1 ? 'Location is off for RideGrid — allow it in the phone settings.' : e.code === 3 ? 'Still looking for GPS…' : 'Location unavailable';
      if (e.code === 1) this.stop();
      this.emit();
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  },
  stop() { if (watch !== null) navigator.geolocation.clearWatch(watch); watch = null; },
  /** Wait for the first fix (or the current one). */
  next(timeoutMs = 15000): Promise<LiveFix> {
    if (this.fix && Date.now() - this.fix.at < 10000) return Promise.resolve(this.fix);
    this.start();
    return new Promise((ok, bad) => {
      const t = setTimeout(() => { off(); bad(new Error(this.error || 'Could not find your location — are you indoors?')); }, timeoutMs);
      const off = this.subscribe((f) => { if (f && Date.now() - f.at < 10000) { clearTimeout(t); off(); ok(f); } else if (this.denied) { clearTimeout(t); off(); bad(new Error(this.error)); } });
    });
  },
};

/** Start with the app, pause in the background, and follow the phone's compass for the direction beam. */
export function startLiveLocation() {
  const vis = () => (document.visibilityState === 'visible' ? live.start() : live.stop());
  document.addEventListener('visibilitychange', vis);
  vis();
  const onOri = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
    const h = e.webkitCompassHeading ?? (e.absolute && e.alpha != null ? 360 - e.alpha : null);
    if (h == null) return;
    const scr = (screen.orientation?.angle ?? 0);
    const nh = (h + scr + 360) % 360;
    if (compass !== null && Math.abs(((nh - compass + 540) % 360) - 180) < 4) return; // ignore jitter
    compass = nh;
    if (live.fix && (live.fix.speed ?? 0) <= 1.5) { live.fix = { ...live.fix, heading: compass }; live.emit(); }
  };
  window.addEventListener('deviceorientationabsolute' as any, onOri as any);
  window.addEventListener('deviceorientation', onOri as any);
}
