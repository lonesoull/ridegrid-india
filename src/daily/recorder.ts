import { db, uid, type Ride, type RidePoint } from '../core/db';
import { engine } from '../core/engine';
import { haversine, type LngLat } from '../core/geo';
import { watchGps, type GpsFix } from '../nav/gps';
import { nav } from '../nav/navigator';
import { getSetting, putSetting } from '../core/db';

/**
 * Daily track recording (OsmAnd "Trip recording"): records GPS tracks without navigating, in the
 * background on Android, with OsmAnd-style filters, auto-split on long gaps, and a folder library.
 */
export interface RecSettings { minDistM: number; maxAccM: number; minSpeedKmh: number; splitMin: number; folder: string }
export const DEFAULT_REC: RecSettings = { minDistM: 5, maxAccM: 50, minSpeedKmh: 0, splitMin: 15, folder: 'Rides' };

export const recorder = {
  on: false, startedAt: 0, distM: 0, points: 0,
  s: { ...DEFAULT_REC },
  ride: null as Ride | null,
  buf: [] as RidePoint[],
  last: null as { p: LngLat; t: number } | null,
  stopGps: null as null | (() => void),
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  async load() { this.s = { ...DEFAULT_REC, ...(await getSetting('recorder', DEFAULT_REC)) }; },
  async setSettings(p: Partial<RecSettings>) { this.s = { ...this.s, ...p }; await putSetting('recorder', this.s); this.emit(); },

  async start() {
    if (this.on) return;
    this.on = true; this.startedAt = Date.now(); this.distM = 0; this.points = 0; this.last = null;
    await this.newRide();
    this.stopGps = await watchGps((f) => this.onFix(f), () => {});
    this.emit();
  },
  async stop() {
    if (!this.on) return;
    this.on = false;
    this.stopGps?.(); this.stopGps = null;
    await this.flush(true);
    this.emit();
  },
  async newRide() {
    await this.flush(true);
    const t = engine.trip!;
    this.ride = { id: uid(), tripId: t.id, startedAt: Date.now(), distM: 0, points: 0, simulated: false, name: `Track ${new Date().toLocaleString('en-IN')}`, folder: this.s.folder, source: 'recorder' };
    await db.rides.put(this.ride);
  },
  onFix(f: GpsFix) {
    // navigation (live) is already logging this ride
    if (nav.mode === 'live' || f.mock) return;
    if (f.acc > this.s.maxAccM) return;
    const p: LngLat = [f.lng, f.lat];
    const mps = f.speed ?? 0;
    if (this.last) {
      const d = haversine(this.last.p, p), gap = (f.time - this.last.t) / 60000;
      if (gap > this.s.splitMin && d > 200) { void this.newRide(); this.last = null; }
      else {
        if (d < this.s.minDistM) return;
        if (mps * 3.6 < this.s.minSpeedKmh) return;
        if (d / Math.max(1, (f.time - this.last.t) / 1000) < 70) { this.distM += d; if (this.ride) this.ride.distM += d; }
      }
    }
    this.last = { p, t: f.time };
    this.buf.push([f.time, f.lng, f.lat, Math.round(f.acc), mps, f.alt ?? NaN] as RidePoint);
    this.points++;
    if (this.ride) this.ride.points++;
    if (this.buf.length >= 30) void this.flush(false);
    this.emit();
  },
  async flush(final: boolean) {
    const r = this.ride;
    if (!r) return;
    if (this.buf.length) { const pts = this.buf; this.buf = []; await db.rideChunks.add({ rideId: r.id, pts }); }
    r.endedAt = Date.now();
    if (final && r.points < 2) { await db.rides.delete(r.id); await db.rideChunks.where('rideId').equals(r.id).delete(); this.ride = null; return; }
    await db.rides.put(r);
    if (final) this.ride = null;
  },
};
