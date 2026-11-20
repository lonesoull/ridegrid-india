import { engine } from '../core/engine';
import { nav } from './navigator';
import { say } from './audio';

/**
 * Hand-off to the phone's Google Maps app (both modes): Google Maps takes at most 10 stops per trip,
 * so RideGrid sends the next 10 stops / waypoints from where you are, and the next 10 after you pass
 * the last of them — automatically, or with a "Next 10" button. RideGrid keeps running behind it:
 * GPS track, logbook, voice alerts and (expedition) the rule checks.
 */
const PER = 10;
const ll = (i: number) => `${engine.stops[i].lat.toFixed(6)},${engine.stops[i].lng.toFixed(6)}`;

/** Google Maps link from the current location through stops from..from+9 (no origin = "your location"). */
export function handoffUrl(from: number): string | null {
  const n = engine.stops.length;
  if (from >= n) return null;
  const to = Math.min(n - 1, from + PER - 1);
  const wps: string[] = [];
  for (let i = from; i < to; i++) wps.push(ll(i));
  let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(ll(to))}&travelmode=two-wheeler&dir_action=navigate`;
  if (wps.length) url += `&waypoints=${wps.map(encodeURIComponent).join('%7C')}`;
  return url;
}

export const handoff = {
  /** a hand-off is running: last stop index sent to Google Maps */
  sentTo: -1,
  due: false,
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  /** Send the next 10 from the next stop on. */
  open() {
    const from = Math.max(0, nav.next);
    const url = handoffUrl(from);
    if (!url) return;
    this.sentTo = Math.min(engine.stops.length - 1, from + PER - 1);
    this.due = false;
    window.open(url, '_blank', 'noopener');
    this.emit();
  },
  stop() { this.sentTo = -1; this.due = false; this.emit(); },
};

/** Watch progress: once the last stop sent to Google Maps is passed, open the next 10 (auto) or show the button. */
export function startHandoffWatch() {
  nav.subscribe(() => {
    if (nav.mode === 'off') { if (handoff.sentTo >= 0) handoff.stop(); return; }
    if (handoff.sentTo < 0 || nav.next <= handoff.sentTo || nav.next >= engine.stops.length) return;
    if (nav.settings.handoffAuto) {
      if (nav.settings.voice) say('Opening the next ten stops in Google Maps');
      handoff.open();
    } else if (!handoff.due) { handoff.due = true; if (nav.settings.voice) say('Next ten stops ready for Google Maps'); handoff.emit(); }
  });
}
