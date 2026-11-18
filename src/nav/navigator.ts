import { db, uid, getSetting, putSetting, type Ride, type RidePoint } from '../core/db';
import { engine } from '../core/engine';
import { haversine, type LngLat } from '../core/geo';
import { buildRouteLine, matchToRoute, pointAt, withApproach, type RouteLine } from './routeLine';
import { sounds, say, unlockAudio, WakeLock } from './audio';

export type NavMode = 'off' | 'live' | 'sim';
export interface NavSettings {
  offRouteM: number;   // 25–200
  arrivalM: number;    // 15–100
  beep: boolean;
  voice: boolean;
  logSim: boolean;     // count simulated rides as "covered" (testing only)
  simKmh: number;      // 1× simulation speed
}
export const DEFAULT_NAV: NavSettings = { offRouteM: 50, arrivalM: 30, beep: true, voice: true, logSim: false, simKmh: 50 };
export const SIM_SPEEDS = [1, 10, 50, 500] as const;

const MAX_ACC_M = 50;          // ignore GPS fixes worse than this for "covered" distance
const OFF_REPEAT_MS = 8000;    // repeat off-route alarm while still off

type Listener = () => void;

export class Navigator {
  mode: NavMode = 'off';
  settings: NavSettings = DEFAULT_NAV;
  playing = false;
  mult = 10;
  line: RouteLine | null = null;
  s = 0;                         // progress along route (m)
  pos: LngLat | null = null;
  heading = 0;
  speedMps = 0;
  accuracy = 0;
  next = 0;                      // index of the next stop to reach
  offRoute = false;
  offDist = 0;
  ride: Ride | null = null;
  track: LngLat[] = [];
  gpsError = '';
  /** stops passed without coming within the arrival radius (live rides) */
  missed: number[] = [];
  version = 0;
  wake = new WakeLock();

  private listeners = new Set<Listener>();
  private raf = 0;
  private lastT = 0;
  private simClock = 0;
  private watchId: number | null = null;
  private matchIdx = 0;
  private offCount = 0;
  private lastOffAlarm = 0;
  private lastLogged: LngLat | null = null;
  private chunk: RidePoint[] = [];
  private lastFlush = 0;
  private pendingCovered = 0;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    engine.subscribe((e) => {
      if (this.mode === 'off' || (!e.stops && !e.legs)) return;
      if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(() => this.rebuildLine(), 800);
    });
  }

  subscribe(f: Listener) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  private emit() { this.version++; this.listeners.forEach((f) => f()); }

  async loadSettings() { this.settings = { ...DEFAULT_NAV, ...(await getSetting('nav', DEFAULT_NAV)) }; }
  async setSettings(p: Partial<NavSettings>) { this.settings = { ...this.settings, ...p }; await putSetting('nav', this.settings); this.emit(); }

  get stopCount() { return engine.stops.length; }
  get distToNext() { return this.line && this.next < this.stopCount ? Math.max(0, this.line.stopS[this.next] - this.s) : 0; }
  get remaining() { return this.line ? Math.max(0, this.line.total - this.s) : 0; }
  get done() { return this.next >= this.stopCount; }

  // ---------------------------------------------------------------- start / stop
  /** Road path from the rider's position to the first stop (null = start exactly at that stop). */
  approach: LngLat[] | null = null;
  private fromStop = 0;

  async start(mode: 'live' | 'sim', fromStop = 0, approach: LngLat[] | null = null) {
    if (!engine.stops.length || (engine.stops.length < 2 && !approach)) throw new Error('Add at least 2 stops first.');
    await this.stop();
    unlockAudio();
    fromStop = Math.max(0, Math.min(fromStop, engine.stops.length - 1));
    this.approach = approach && approach.length >= 2 ? approach : null;
    this.fromStop = fromStop;
    this.line = this.composeLine();
    this.mode = mode;
    this.s = this.approach ? 0 : this.line.stopS[fromStop];
    this.next = this.approach ? fromStop : fromStop + 1;
    this.matchIdx = pointAt(this.line, this.s).idx;
    this.offRoute = false; this.offDist = 0; this.offCount = 0; this.missed = [];
    this.track = []; this.lastLogged = null; this.chunk = []; this.pendingCovered = 0;
    this.gpsError = '';
    const t = engine.trip!;
    const logging = mode === 'live' || this.settings.logSim;
    this.ride = logging ? { id: uid(), tripId: t.id, startedAt: Date.now(), distM: 0, points: 0, simulated: mode === 'sim', name: `${mode === 'sim' ? 'Simulated ride' : 'Ride'} ${new Date().toLocaleString('en-IN')}` } : null;
    if (this.ride) await db.rides.put(this.ride);
    await this.wake.on();

    if (mode === 'sim') {
      const at = pointAt(this.line, this.s);
      this.pos = at.p; this.heading = at.heading;
      this.simClock = Date.now();
      this.playing = true;
      this.lastT = 0;
      this.raf = requestAnimationFrame((ts) => this.tick(ts));
      if (this.settings.voice) say(this.approach ? `Simulation started. Heading to stop ${fromStop + 1}` : `Simulation started from stop ${fromStop + 1}`);
    } else {
      if (!navigator.geolocation) throw new Error('GPS is not available on this device.');
      this.pos = null;
      this.watchId = navigator.geolocation.watchPosition(
        (p) => this.onFix(p),
        (e) => { this.gpsError = e.code === 1 ? 'Location permission denied — allow location for this site.' : `GPS: ${e.message}`; this.emit(); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
      );
      if (this.settings.voice) say(`Navigation started. Heading to stop ${this.next + 1}`);
    }
    this.emit();
  }

  async stop() {
    if (this.mode === 'off') return;
    cancelAnimationFrame(this.raf);
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.playing = false;
    await this.flushLog(true);
    this.mode = 'off';
    await this.wake.off();
    this.emit();
  }

  togglePlay() {
    if (this.mode !== 'sim') return;
    if (this.done || (this.line && this.s >= this.line.total)) return;
    this.playing = !this.playing;
    this.lastT = 0;
    if (this.playing) this.raf = requestAnimationFrame((ts) => this.tick(ts));
    this.emit();
  }
  setMult(m: number) { this.mult = m; this.emit(); }

  /** Jump (sim) to a stop: useful for testing a far part of the route. */
  jumpTo(stop: number) {
    if (!this.line || this.mode !== 'sim') return;
    stop = Math.max(0, Math.min(stop, this.stopCount - 1));
    this.s = this.line.stopS[stop];
    this.next = stop + 1;
    const at = pointAt(this.line, this.s);
    this.pos = at.p; this.heading = at.heading; this.matchIdx = at.idx;
    this.track = [];
    this.lastLogged = null;
    this.emit();
  }

  // ---------------------------------------------------------------- simulation
  private tick(ts: number) {
    if (this.mode !== 'sim' || !this.playing || !this.line) return;
    const dt = this.lastT ? Math.min(0.25, (ts - this.lastT) / 1000) : 0;
    this.lastT = ts;
    const v = (this.settings.simKmh / 3.6) * this.mult;
    this.s = Math.min(this.line.total, this.s + v * dt);
    this.simClock += dt * this.mult * 1000;
    const at = pointAt(this.line, this.s);
    this.pos = at.p; this.heading = at.heading; this.speedMps = this.settings.simKmh / 3.6; this.matchIdx = at.idx;
    this.accuracy = 0;
    this.addTrackPoint(at.p, this.simClock, 0, this.speedMps, true);
    this.checkArrivals();
    if (this.s >= this.line.total) {
      this.playing = false;
      this.next = this.stopCount;
      if (this.settings.voice) say('Route complete');
      void this.flushLog(false);
    }
    this.emit();
    if (this.playing) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  // ---------------------------------------------------------------- live GPS
  private onFix(f: GeolocationPosition) {
    if (this.mode !== 'live' || !this.line) return;
    const p: LngLat = [f.coords.longitude, f.coords.latitude];
    const prev = this.pos;
    this.pos = p;
    this.accuracy = f.coords.accuracy;
    this.gpsError = '';
    this.speedMps = f.coords.speed ?? (prev ? 0 : 0);
    if (f.coords.heading != null && !Number.isNaN(f.coords.heading) && (f.coords.speed ?? 0) > 1) this.heading = f.coords.heading;
    else if (prev && haversine(prev, p) > 3) this.heading = bearingDeg(prev, p);

    const good = f.coords.accuracy <= MAX_ACC_M;
    this.addTrackPoint(p, f.timestamp, f.coords.accuracy, f.coords.speed ?? 0, good);
    if (good) {
      const m = matchToRoute(this.line, p, this.matchIdx);
      this.offDist = m.d;
      const thr = this.settings.offRouteM;
      if (m.d > thr) {
        if (++this.offCount >= 2 && !this.offRoute) { this.offRoute = true; this.alarmOff(true); }
        else if (this.offRoute && Date.now() - this.lastOffAlarm > OFF_REPEAT_MS) this.alarmOff(false);
      } else if (m.d < thr * 0.7) {
        this.offCount = 0;
        if (this.offRoute) { this.offRoute = false; if (this.settings.beep) sounds.backOnRoute(); if (this.settings.voice) say('Back on route'); }
      }
      if (!this.offRoute) { this.s = m.s; this.matchIdx = m.idx; }
      this.checkArrivals();
    }
    this.emit();
  }

  private alarmOff(first: boolean) {
    this.lastOffAlarm = Date.now();
    if (this.settings.beep) sounds.offRoute();
    if (this.settings.voice) say(first ? `Off route. ${Math.round(this.offDist)} metres from your planned road.` : `Still off route, ${Math.round(this.offDist)} metres`);
  }

  // ---------------------------------------------------------------- arrivals
  private checkArrivals() {
    if (!this.line) return;
    const S = engine.stops;
    let arrived = -1;
    const missedNow: number[] = [];
    while (this.next < S.length) {
      const st = S[this.next];
      const near = this.pos ? haversine(this.pos, [st.lng, st.lat]) <= this.settings.arrivalM : false;
      const passed = this.s >= this.line.stopS[this.next];
      if (!near && !passed) break;
      // live: passing a stop's position on the route without ever getting within the arrival radius = missed
      if (this.mode === 'live' && !near && this.s - this.line.stopS[this.next] > this.settings.arrivalM) missedNow.push(this.next);
      else arrived = this.next;
      this.next++;
    }
    if (missedNow.length) {
      this.missed.push(...missedNow);
      if (this.settings.beep) sounds.offRoute();
      if (this.settings.voice) say(missedNow.length === 1 ? `Stop ${missedNow[0] + 1} missed` : `${missedNow.length} stops missed`);
    } else if (arrived >= 0 && (this.mode === 'live' || this.mult <= 50)) {
      // at high sim speeds many stops pass per second; only chime when it's audible
      if (this.settings.beep) sounds.arrival();
      if (this.settings.voice) say(this.next >= S.length ? `Arrived at final stop ${arrived + 1}` : `Stop ${arrived + 1} reached. Next, stop ${this.next + 1}`);
    }
  }

  // ---------------------------------------------------------------- ride log
  private addTrackPoint(p: LngLat, t: number, acc: number, spd: number, good: boolean) {
    const last = this.lastLogged;
    const d = last ? haversine(last, p) : 0;
    if (last && d < (this.mode === 'sim' ? 25 : 5)) return; // decimate
    this.lastLogged = p;
    this.track.push(p);
    if (this.track.length > 20000) this.track = this.track.filter((_, i) => i % 2 === 0); // keep drawing light
    if (!this.ride) return;
    this.chunk.push([Math.round(t), +p[0].toFixed(7), +p[1].toFixed(7), Math.round(acc), +spd.toFixed(2)]);
    this.ride.points++;
    // count as covered only for trustworthy fixes and plausible jumps (< 250 km/h)
    if (good && last && d < 70 * Math.max(1, (this.mode === 'sim' ? this.mult : 1)) * 5) { this.ride.distM += d; this.pendingCovered += d; }
    if (this.chunk.length >= 50 || Date.now() - this.lastFlush > 15000) void this.flushLog(false);
  }

  private async flushLog(final: boolean) {
    this.lastFlush = Date.now();
    const r = this.ride;
    if (!r) return;
    const pts = this.chunk; this.chunk = [];
    const add = this.pendingCovered; this.pendingCovered = 0;
    if (final) r.endedAt = Date.now();
    await db.transaction('rw', db.rides, db.rideChunks, db.trips, async () => {
      if (pts.length) await db.rideChunks.add({ rideId: r.id, pts });
      await db.rides.put({ ...r });
      if (add > 0) {
        const t = await db.trips.get(r.tripId);
        if (t) { t.coveredM = (t.coveredM ?? 0) + add; await db.trips.put(t); if (engine.trip?.id === t.id) engine.trip.coveredM = t.coveredM; }
      }
    });
    if (final) this.ride = null;
  }

  // ---------------------------------------------------------------- route edits while navigating
  private composeLine(): RouteLine {
    const L = buildRouteLine();
    return this.approach ? withApproach(L, this.approach, this.fromStop) : L;
  }

  private rebuildLine() {
    if (this.mode === 'off') return;
    const prevNext = this.next;
    this.line = this.composeLine();
    if (this.pos) {
      const m = matchToRoute(this.line, this.pos, 0, 0);
      this.s = m.s; this.matchIdx = m.idx;
    }
    // keep the next-stop counter where the rider is, without skipping ahead
    this.next = Math.min(prevNext, this.stopCount);
    this.emit();
  }
}

function bearingDeg(a: LngLat, b: LngLat) {
  const r = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

export const nav = new Navigator();
