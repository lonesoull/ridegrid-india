import { db, uid, getSetting, putSetting, type Ride, type RidePoint } from '../core/db';
import { engine } from '../core/engine';
import { distToSegmentM, haversine, type LngLat } from '../core/geo';
import { buildRouteLine, matchToRoute, pointAt, withApproach, type Approach, type LineTurn, type RouteLine } from './routeLine';
import { turnText } from '../core/turns';
import { isExpedition, T } from '../core/terms';
import { directionsTo } from './directions';
import { google, googleRoute } from '../core/google';
import { BreakDetector } from './logbook';
import { inIndia } from '../core/india';
import { watchGps, type GpsFix } from './gps';
import { SegIndex, isParallel } from './spatial';
import { cleanPath, deriveTurns, safeRoute, type SafeRoute } from './detour';
import { sounds, say, unlockAudio, WakeLock } from './audio';

export type NavMode = 'off' | 'live' | 'sim';
export interface NavSettings {
  offRouteM: number;   // 25–200
  arrivalM: number;    // 15–100
  beep: boolean;
  voice: boolean;
  logSim: boolean;     // count simulated rides as "covered" (testing only)
  simKmh: number;      // 1× simulation speed
  reroute: boolean;    // when off route, plan a road way back to the next stop
  breakMin: number;    // stationary this long = automatic break log
  gapM: number;        // expedition: minimum distance to keep from any other planned road
  fasterSec: number;   // daily: how often to look for a faster route with live traffic (0 = off)
  witnessesPerDay: number;
  riderName: string; bikeReg: string; bikeModel: string; // printed on evidence photos, logbook and packs
  handoffAuto: boolean; // Google Maps app hand-off: open the next 10 stops automatically (else a button) // expedition: witness signatures expected each riding day (1 or 2)
  evidenceMin: number; // expedition: remind to take an evidence photo/video this often while riding (0 = off)
}
export const DEFAULT_NAV: NavSettings = { offRouteM: 50, arrivalM: 30, beep: true, voice: true, logSim: false, simKmh: 50, reroute: true, breakMin: 5, gapM: 30, fasterSec: 180, evidenceMin: 60, witnessesPerDay: 1, riderName: '', bikeReg: '', bikeModel: '', handoffAuto: false };
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
  /** GPS altitude (m), when available */
  altitude: number | null = null;
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
  breaks = new BreakDetector(() => ({ tripId: engine.trip!.id, rideId: this.ride?.id, minMinutes: this.settings.breakMin }));

  private listeners = new Set<Listener>();
  private raf = 0;
  private lastT = 0;
  private simClock = 0;
  private stopGps: (() => void) | null = null;
  /** GPS fixes flagged by Android as coming from a mock-location (fake GPS) app */
  mockFixes = 0;
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

  async loadSettings() {
    this.settings = { ...DEFAULT_NAV, ...(await getSetting('nav', DEFAULT_NAV)) };
    // Google two-wheeler checks are Enterprise-priced: move the old 1-minute default to 3 minutes once
    if (this.settings.fasterSec === 60 && !(await getSetting('faster3min', false))) { await putSetting('faster3min', true); await this.setSettings({ fasterSec: 180 }); }
  }
  async setSettings(p: Partial<NavSettings>) { this.settings = { ...this.settings, ...p }; await putSetting('nav', this.settings); this.emit(); }

  get stopCount() { return engine.stops.length; }
  get distToNext() { return this.line && this.next < this.stopCount ? Math.max(0, this.line.stopS[this.next] - this.s) : 0; }
  get remaining() { return this.line ? Math.max(0, this.line.total - this.s) : 0; }
  get done() { return this.next >= this.stopCount; }

  // ---------------------------------------------------------------- turn-by-turn
  /** spoken stages per turn: 1 = early (≈500 m), 2 = near (≈150 m), 3 = now */
  private spoken = new Map<number, number>();
  rerouting = false;
  reroutes = 0;
  private lastReroute = 0;

  /** Index into line.turns of the next maneuver ahead of the rider. */
  get turnIdx(): number {
    const T = this.line?.turns;
    if (!T) return -1;
    let lo = 0, hi = T.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m].s <= this.s + 3) lo = m + 1; else hi = m; }
    return lo < T.length ? lo : -1;
  }
  get nextTurn(): (LineTurn & { dist: number }) | null {
    const k = this.turnIdx;
    if (k < 0 || !this.line) return null;
    const t = this.line.turns[k];
    // don't show a turn that lies beyond the next stop's arrival as "next" if the stop comes first
    return { ...t, dist: t.s - this.s };
  }
  get thenTurn(): (LineTurn & { dist: number }) | null {
    const k = this.turnIdx;
    if (k < 0 || !this.line || k + 1 >= this.line.turns.length) return null;
    const t = this.line.turns[k + 1];
    return { ...t, dist: t.s - this.s };
  }

  private announceTurns() {
    if (!this.settings.voice || !this.line) return;
    if (this.mode === 'sim' && this.mult > 10) return; // too fast to be useful
    const k = this.turnIdx;
    if (k < 0) return;
    const t = this.line.turns[k];
    const d = t.s - this.s;
    const v = Math.max(this.mode === 'sim' ? this.settings.simKmh / 3.6 : this.speedMps, 8);
    const early = Math.max(300, v * 25), near = Math.max(80, v * 8), now = Math.max(25, v * 2.5);
    const stage = this.spoken.get(k) ?? 0;
    const txt = turnText(t);
    const fmt = (m: number) => (m >= 950 ? `${(m / 1000).toFixed(1)} kilometres` : `${Math.round(m / 50) * 50 || Math.round(m)} metres`);
    if (d <= now && stage < 3) { this.spoken.set(k, 3); say(txt); }
    else if (d <= near && stage < 2) { this.spoken.set(k, 2); say(`In ${fmt(d)}, ${txt.charAt(0).toLowerCase() + txt.slice(1)}`); }
    else if (d <= early && d > near * 1.5 && stage < 1) { this.spoken.set(k, 1); say(`In ${fmt(d)}, ${txt.charAt(0).toLowerCase() + txt.slice(1)}`); }
  }

  /** Off route: plan a road route from here back to the next stop and follow it (like Google's re-route). */
  private async reroute() {
    if (!this.settings.reroute || this.rerouting || !this.pos || this.done) return;
    if (Date.now() - this.lastReroute < 20000) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    this.rerouting = true; this.lastReroute = Date.now(); this.emit();
    try {
      const target = this.next;
      const d = await directionsTo(target, this.pos);
      if (this.mode !== 'live' || !d.routed) return;
      this.approach = { coords: d.coords, turns: d.turns };
      this.fromStop = target;
      this.line = this.composeLine();
      this.s = 0; this.matchIdx = 0; this.next = target;
      this.offRoute = false; this.offCount = 0; this.spoken = new Map();
      this.reroutes++;
      if (this.settings.voice) say(`Rerouting. ${Math.round(d.distM / 100) / 10} kilometres to stop ${target + 1}`);
    } catch { /* keep alarming; try again later */ }
    finally { this.rerouting = false; this.emit(); }
  }

  // ---------------------------------------------------------------- start / stop
  /** Road path from the rider's position to the first stop (null = start exactly at that stop). */
  approach: Approach | null = null;
  private fromStop = 0;

  async start(mode: 'live' | 'sim', fromStop = 0, approach: Approach | null = null) {
    if (!engine.stops.length || (engine.stops.length < 2 && !approach)) throw new Error('Add at least 2 stops first.');
    await this.stop();
    unlockAudio();
    fromStop = Math.max(0, Math.min(fromStop, engine.stops.length - 1));
    this.approach = approach && approach.coords.length >= 2 ? approach : null;
    this.spoken = new Map(); this.rerouting = false; this.lastReroute = 0; this.reroutes = 0; this.joinedAt = null; this.lastJoinCheck = 0; this.routeUpdates = 0;
    this.detour = null; this.guard = null; this.approachStartS = null; this.joinWin = null; this.parRun = 0;
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
      this.pos = null; this.mockFixes = 0;
      this.stopGps = await watchGps((f) => this.onFix(f), (msg) => { this.gpsError = msg; this.emit(); });
      this.faster = null; this.liveEta = null; this.fasterQuietUntil = 0;
      this.scheduleFaster(15000);
      if (this.settings.voice) say(`Navigation started. Heading to ${T().one} ${this.next + 1}`);
    }
    this.emit();
  }

  async stop() {
    if (this.mode === 'off') return;
    cancelAnimationFrame(this.raf);
    this.stopGps?.(); this.stopGps = null;
    if (this.fasterTimer) clearTimeout(this.fasterTimer);
    this.fasterTimer = null; this.faster = null; this.liveEta = null;
    this.playing = false;
    await this.breaks.close();
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

  // ---------------------------------------------------------------- daily: faster routes + live ETA
  /** a faster way to the next stop found with live traffic, waiting for the rider's decision */
  faster: { savingS: number; durS: number; coords: LngLat[]; turns: import('../core/turns').Turn[]; at: number } | null = null;
  /** Google's live-traffic time to the next stop along the current route */
  liveEta: { toNextS: number; at: number } | null = null;
  private fasterTimer: ReturnType<typeof setTimeout> | null = null;
  private fasterQuietUntil = 0;
  private checking = false;

  private scheduleFaster(delayMs: number) {
    if (this.fasterTimer) clearTimeout(this.fasterTimer);
    this.fasterTimer = null;
    if (this.mode !== 'live' || isExpedition() || !this.settings.fasterSec) return;
    this.fasterTimer = setTimeout(() => void this.checkFaster().finally(() => this.scheduleFaster(this.settings.fasterSec * 1000)), delayMs);
  }

  /** Ask Google (live traffic) for the best route to the next stop and the time of the route we're on. */
  async checkFaster() {
    if (this.checking || !google.active || !this.pos || !this.line || this.offRoute || this.done) return;
    const st = engine.stops[this.next];
    if (!st) return;
    const to: LngLat = [st.lng, st.lat];
    const endS = this.line.stopS[this.next];
    const span = endS - this.s;
    if (span < 300) return;
    const via = span > 1500 ? [0.25, 0.5, 0.75].map((f) => pointAt(this.line!, this.s + span * f).p) : [];
    this.checking = true;
    try {
      const key = google.settings.key;
      const [best, cur] = await Promise.all([googleRoute(key, this.pos, to), via.length ? googleRoute(key, this.pos, to, undefined, via) : Promise.resolve(null)]);
      const curS = cur?.durS ?? best.durS;
      this.liveEta = { toNextS: curS, at: Date.now() };
      const saving = curS - best.durS;
      if (cur && saving >= Math.max(120, curS * 0.08) && Date.now() > this.fasterQuietUntil) {
        const isNew = !this.faster;
        this.faster = { savingS: saving, durS: best.durS, coords: [this.pos, ...best.coords, to], turns: best.turns.map((t) => ({ ...t, i: t.i + 1 })), at: Date.now() };
        if (isNew) {
          if (this.settings.beep) sounds.arrival();
          if (this.settings.voice) say(`Faster route available. Saves ${Math.round(saving / 60)} minutes.`);
        }
      } else this.faster = null;
      this.emit();
    } catch { /* offline / quota: try again next round */ }
    finally { this.checking = false; }
  }

  takeFaster() {
    const f = this.faster;
    if (!f || !this.pos) return;
    this.approach = { coords: f.coords, turns: f.turns };
    this.approachStartS = null; this.joinWin = null;
    this.fromStop = this.next;
    this.line = this.composeLine();
    this.s = 0; this.matchIdx = 0;
    this.faster = null; this.spoken = new Map();
    this.liveEta = { toNextS: f.durS, at: Date.now() };
    if (this.settings.voice) say('Taking the faster route');
    this.emit();
  }
  ignoreFaster() { this.faster = null; this.fasterQuietUntil = Date.now() + 5 * 60000; this.emit(); }

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
    this.announceTurns();
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
  private onFix(f: GpsFix) {
    if (this.mode !== 'live' || !this.line) return;
    const p: LngLat = [f.lng, f.lat];
    // record integrity: positions from a fake-GPS app are never used or counted
    if (f.mock) {
      this.mockFixes++;
      this.gpsError = 'FAKE GPS detected (mock-location app). These positions are ignored and not logged — turn the mock app off.';
      this.emit();
      return;
    }
    // a Wi-Fi / IP (or VPN) location is not usable for riding: keep the last good position and say why
    if (f.acc > 1500 || !inIndia(p)) {
      this.gpsError = `Location from Wi-Fi/internet, not GPS (±${(f.acc / 1000).toFixed(1)} km${inIndia(p) ? '' : ', outside India — VPN on?'}). Waiting for a real GPS fix…`;
      this.emit();
      return;
    }
    const prev = this.pos;
    this.pos = p;
    this.accuracy = f.acc;
    this.altitude = f.alt ?? null;
    this.gpsError = '';
    this.speedMps = f.speed ?? 0;
    if (f.heading != null && !Number.isNaN(f.heading) && (f.speed ?? 0) > 1) this.heading = f.heading;
    else if (prev && haversine(prev, p) > 3) this.heading = bearingDeg(prev, p);

    const good = f.acc <= MAX_ACC_M;
    this.addTrackPoint(p, f.time, f.acc, f.speed ?? 0, good);
    if (good) void this.breaks.onFix(p, f.time, f.speed ?? 0, f.acc);
    if (good && this.tryJoin(p)) { this.checkArrivals(); this.emit(); return; }
    const exp = isExpedition();
    if (good) {
      // Expedition: never "snap" to a far-away part of the planned route (that would skip waypoints).
      // On a detour, only the departure area counts as rejoining.
      const dep = this.detour && !this.approach ? this.detour : null;
      const hint = dep ? pointAt(this.line, dep.depS).idx : this.matchIdx;
      let m = matchToRoute(this.line, p, hint, exp ? Infinity : 300);
      if (dep && (m.s < dep.depS - 150 || m.s > dep.depS + 300)) m = { ...m, d: Math.max(m.d, this.settings.offRouteM + 1) };
      this.offDist = m.d;
      const thr = this.settings.offRouteM;
      if (m.d > thr) {
        if (++this.offCount >= 2 && !this.offRoute) {
          this.offRoute = true;
          if (exp && !this.approach && !this.detour) {
            // expedition: leaving the planned road starts a detour (stop/signature) — remember exactly where
            this.detour = { depS: this.s, depPt: pointAt(this.line, this.s).p, track: [pointAt(this.line, this.s).p, p], startedAt: Date.now() };
            if (this.settings.beep) sounds.offRoute();
            if (this.settings.voice) say('Left the planned route. Detour mode on. Keep away from your other planned roads.');
          } else this.alarmOff(true);
        } else if (this.offRoute && !exp && Date.now() - this.lastOffAlarm > OFF_REPEAT_MS) this.alarmOff(false);
      } else if (m.d < thr * 0.7) {
        this.offCount = 0;
        if (this.offRoute) {
          this.offRoute = false;
          if (this.detour && !this.approach) {
            const d = this.detour;
            this.detour = null; this.guard = null;
            if (m.s < d.depS - 50 && this.settings.voice) say('Warning. You rejoined behind where you left. This repeats road.');
            else if (this.settings.voice) say('Back on the planned route');
          } else if (this.settings.voice) say('Back on route');
          if (this.settings.beep) sounds.backOnRoute();
        }
      }
      if (!this.offRoute) { this.s = m.s; this.matchIdx = m.idx; this.announceTurns(); }
      else if (!exp) void this.reroute();
      if (this.detour && (!prev || haversine(prev, p) > 5)) this.detour.track.push(p);
      if (exp) this.runGuard(p, prev ? haversine(prev, p) : 0);
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
    const exp = isExpedition(), t = T();
    if (missedNow.length) {
      this.missed.push(...missedNow);
      if (this.settings.beep) sounds.offRoute();
      if (this.settings.voice) say(missedNow.length === 1 ? `${t.One} ${missedNow[0] + 1} missed` : `${missedNow.length} ${t.many} missed`);
    } else if (exp) {
      // expedition: waypoints only pin the road — pass silently, announce only the end of the route
      if (arrived >= 0 && this.next >= S.length && this.settings.voice) say('End of planned route');
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
  /** The planned route without any approach prefix (used to detect joining it early). */
  private fullLine: RouteLine | null = null;
  private lastJoinCheck = 0;
  joinedAt: number | null = null;
  /** times the planned route geometry changed during this ride */
  routeUpdates = 0;

  // ---------------------------------------------------------------- expedition detour mode
  /** where the rider left the planned route (along-route distance + point) and the path ridden since */
  detour: { depS: number; depPt: LngLat; track: LngLat[]; startedAt: number; returning?: 'same' | 'safe' } | null = null;
  /** proximity guard: how close the rider is to another part of the planned route */
  guard: { level: 'warn' | 'danger' | 'parallel'; d: number } | null = null;
  private approachStartS: number | null = null;
  private joinWin: [number, number] | null = null;
  private idx: SegIndex | null = null;
  private parRun = 0;
  private lastGuardSay = 0;
  private lastGuardLevel: string | null = null;

  private index() {
    if (!this.idx && this.fullLine) this.idx = new SegIndex(this.fullLine);
    return this.idx;
  }

  /** Part of the planned route the rider is allowed to be near right now. */
  private guardSkip(): [number, number] | null {
    const F = this.fullLine;
    if (!F) return null;
    if (this.approach) { const st = this.approachStartS ?? F.stopS[this.fromStop]; return [st - 300, st + 300]; }
    if (this.detour) return [this.detour.depS - 150, this.detour.depS + 150];
    return null;
  }

  /** Expedition rule: off the planned route, keep ≥ gap from every other planned road (incl. parallel carriageways). */
  private runGuard(p: LngLat, moved: number) {
    const skip = this.guardSkip();
    const idx = skip ? this.index() : null;
    if (!skip || !idx) { this.guard = null; this.parRun = 0; return; }
    const gap = this.settings.gapM, acc = Math.min(this.accuracy || 0, 25);
    const near = idx.nearest(p, gap + acc + 60, [skip]);
    let g: Navigator['guard'] = null;
    if (near && near.d < gap + acc) g = { level: 'danger', d: near.d };
    else if (near && near.d < gap + acc + 40) g = { level: 'warn', d: near.d };
    const par = idx.nearest(p, 80, [skip]);
    if (par && this.speedMps > 2 && isParallel(this.heading, par.bearing)) this.parRun += moved; else this.parRun = 0;
    if (this.parRun >= 100 && (!g || g.level !== 'danger')) g = { level: 'parallel', d: par!.d };
    this.guard = g;
    const now = Date.now();
    const lvl = g?.level ?? null;
    if (lvl && (lvl !== this.lastGuardLevel || (lvl !== 'warn' && now - this.lastGuardSay > 6000))) {
      this.lastGuardSay = now;
      if (this.settings.beep) sounds.offRoute();
      if (this.settings.voice) say(lvl === 'danger' ? `Too close to your planned road. ${Math.round(g!.d)} metres. Keep away.`
        : lvl === 'parallel' ? 'You are riding parallel to your planned road. Move away.'
        : `Planned road ahead, ${Math.round(g!.d)} metres`);
    }
    this.lastGuardLevel = lvl;
  }

  /** First waypoint at or after along-route distance s. */
  private stopAfter(s: number) {
    const F = this.fullLine!;
    let k = 0;
    while (k < this.stopCount && F.stopS[k] < s) k++;
    return k;
  }

  private applyReturn(coords: LngLat[], turns: import('../core/turns').Turn[], how: 'same' | 'safe') {
    if (!this.fullLine) return;
    const d = this.detour;
    if (!d || !this.fullLine) return;
    // announce the turn back onto the planned road at the departure point
    const tailFrom = coords.slice(-8);
    const onto = deriveTurns([...tailFrom, pointAt(this.fullLine, d.depS + 40).p]).filter((t) => t.i === tailFrom.length - 1);
    if (onto.length && !turns.some((t) => t.i >= coords.length - 2)) turns = [...turns, { ...onto[0], i: coords.length - 1, txt: `${turnText(onto[0])} back onto your planned route` }];
    this.approach = { coords, turns };
    this.approachStartS = d.depS;
    this.fromStop = this.stopAfter(d.depS);
    this.joinWin = [d.depS - 100, d.depS + 300];
    this.line = this.composeLine();
    this.s = 0; this.matchIdx = 0; this.next = this.fromStop;
    this.offRoute = false; this.offCount = 0; this.spoken = new Map();
    d.returning = how;
    this.emit();
  }

  /** Guide back exactly along the path ridden since leaving the route (guaranteed not to touch other planned roads). */
  returnSameWay() {
    const d = this.detour;
    if (!d || !this.pos) return false;
    // join the recorded track at the point closest to where the rider is now (skips any dead-end bit ridden after it)
    // earliest recorded segment the rider is standing on (within 25 m); else the closest earlier point
    const tr = d.track, me = this.pos;
    let k = -1;
    for (let i = 0; i < tr.length - 1 && k < 0; i++) if (distToSegmentM(me, tr[i], tr[i + 1]) < 25) k = i;
    if (k < 0) { let best = Infinity; for (let i = 0; i < Math.max(1, tr.length - 3); i++) { const dd = haversine(tr[i], me); if (dd < best) { best = dd; k = i; } } }
    const coords = cleanPath([this.pos, ...d.track.slice(0, k + 1).reverse(), d.depPt]);
    if (coords.length < 2) return false;
    this.applyReturn(coords, deriveTurns(coords), 'same');
    if (this.settings.voice) say('Returning the way you came');
    return true;
  }

  /** Shortest way back to the departure point that keeps the gap from all other planned roads. */
  async planSafeWayBack(): Promise<SafeRoute> {
    const d = this.detour, idx = this.index();
    if (!d || !this.pos || !this.fullLine || !idx) throw new Error('Not on a detour');
    return safeRoute(this.pos, d.depPt, this.fullLine, idx, [d.depS - 150, d.depS + 150], this.settings.gapM);
  }
  useSafeWayBack(r: SafeRoute) {
    const d = this.detour;
    if (!d || !this.pos) return;
    this.applyReturn(cleanPath([this.pos, ...r.coords, d.depPt], 2), r.turns.map((t) => ({ ...t, i: t.i + 1 })), 'safe');
    if (this.settings.voice) say('Returning by the safe route');
  }

  private composeLine(): RouteLine {
    const L = buildRouteLine();
    if (this.fullLine !== L) { this.fullLine = L; this.idx = null; }
    return this.approach ? withApproach(L, this.approach, this.fromStop, this.approachStartS ?? undefined) : L;
  }

  /**
   * While heading to the start stop: if the rider reaches the planned route anywhere from the leg
   * before that stop up to ~3 km / 3 stops past it, drop the approach and continue from there.
   * The rider's position becomes the start; following stops continue in order (none marked missed).
   */
  private tryJoin(p: LngLat): boolean {
    const F = this.fullLine;
    if (!this.approach || !F || F.n < 2 || Date.now() - this.lastJoinCheck < 1500) return false;
    this.lastJoinCheck = Date.now();
    const from = this.fromStop;
    const [lo, hi] = this.joinWin ?? [from > 0 ? F.stopS[from - 1] : 0, Math.max(F.stopS[from] + 3000, F.stopS[Math.min(from + 3, this.stopCount - 1)])];
    const hint = pointAt(F, this.approachStartS ?? F.stopS[from]).idx;
    const m = matchToRoute(F, p, hint, 25);
    if (m.d > Math.min(25, this.settings.offRouteM * 0.6) || m.s < lo || m.s > hi) return false;
    const wasDetour = !!this.detour;
    this.approach = null; this.approachStartS = null; this.joinWin = null; this.detour = null; this.guard = null;
    this.line = F;
    this.s = m.s; this.matchIdx = m.idx;
    let k = wasDetour ? 0 : from;
    while (k < this.stopCount && F.stopS[k] <= m.s + 1) k++;
    this.next = wasDetour ? k : Math.max(from, k);
    if (!wasDetour) this.joinedAt = this.next;
    this.offRoute = false; this.offCount = 0; this.spoken = new Map();
    if (this.settings.beep) sounds.backOnRoute();
    if (this.settings.voice) say(wasDetour ? 'Back on the planned route' : this.done ? 'Joined the route at its end' : `Joined the route. Next ${T().one} ${this.next + 1}`);
    return true;
  }

  private rebuildLine() {
    if (this.mode === 'off') return;
    const prevNext = this.next;
    const old = this.line;
    this.line = this.composeLine();
    if (this.pos) {
      // re-find the rider near the same place on the new geometry (never jump to a far part of the route)
      const hint = pointAt(this.line, this.s).idx;
      const m = matchToRoute(this.line, this.pos, hint, isExpedition() ? Infinity : 300);
      this.s = m.s; this.matchIdx = m.idx;
    }
    // tell the rider when the road geometry ahead actually changed
    if (old && Math.abs(old.total - this.line.total) > 50) {
      this.routeUpdates++;
      if (this.settings.voice && (this.mode === 'live' || this.mult <= 10)) say('Route updated');
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
