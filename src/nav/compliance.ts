import { getSetting, putSetting } from '../core/db';
import { engine } from '../core/engine';
import { haversine, type LngLat } from '../core/geo';
import { pointInPolygon } from '../core/india';
import { isExpedition } from '../core/terms';
import { nav } from './navigator';
import { pointAt } from './routeLine';
import { isParallel } from './spatial';
import { loadExpressways } from './expressways';
import { sounds, say } from './audio';
import { loadStates, statePolygons } from './states';
import { myFix, fixProblem } from './directions';

/**
 * Live Guinness / India rule monitor (while riding):
 *  - two-wheeler-banned expressway underfoot           (#30)
 *  - Inner Line Permit / protected areas ahead & entered (#31)
 *  - night-closed forest roads you'd reach while closed  (#31)
 *  - 48-hour maximum halt in one place                   (#32)
 *  - speed limit 80 km/h on National Highways, 60 elsewhere (#33)
 */
export type AlertKind = 'expressway' | 'speed' | 'permit' | 'night' | 'halt';
export interface CompAlert { kind: AlertKind; level: 'info' | 'warn' | 'danger'; text: string; at: number }
export interface CompSettings { speedOn: boolean; speedNH: number; speedOther: number; haltHours: number; haltRadiusKm: number; permitOn: boolean; nightOn: boolean }
export const DEFAULT_COMP: CompSettings = { speedOn: true, speedNH: 80, speedOther: 60, haltHours: 48, haltRadiusKm: 5, permitOn: true, nightOn: true };

/** Inner Line Permit states (by Natural Earth state name) + protected-area permit zones (approximate circles). */
export const ILP_STATES = ['Arunachal Pradesh', 'Nagaland', 'Mizoram', 'Manipur', 'Lakshadweep'];
export const PERMIT_AREAS: { name: string; c: LngLat; rKm: number; note: string }[] = [
  { name: 'Nubra Valley (Ladakh PAP)', c: [77.55, 34.65], rKm: 55, note: 'Protected Area Permit needed (Leh DC / online)' },
  { name: 'Pangong Tso (Ladakh PAP)', c: [78.65, 33.8], rKm: 45, note: 'Protected Area Permit needed' },
  { name: 'Tso Moriri / Changthang (Ladakh PAP)', c: [78.3, 32.9], rKm: 45, note: 'Protected Area Permit needed' },
  { name: 'Hanle (Ladakh PAP)', c: [78.97, 32.79], rKm: 35, note: 'Protected Area Permit needed' },
  { name: 'Dah–Hanu (Ladakh PAP)', c: [76.55, 34.45], rKm: 25, note: 'Protected Area Permit needed' },
  { name: 'North Sikkim (Lachen / Lachung / Gurudongmar)', c: [88.62, 27.85], rKm: 45, note: 'Restricted Area Permit needed (Gangtok)' },
  { name: 'Tsomgo / Nathula (Sikkim)', c: [88.76, 27.38], rKm: 18, note: 'Permit needed (Gangtok)' },
];
/** Forest roads closed at night (approximate lines; verify locally — timings can change). */
export const NIGHT_CLOSURES: { name: string; line: LngLat[]; from: number; to: number }[] = [
  { name: 'Bandipur – NH766 (Gundlupet ↔ Sulthan Bathery)', line: [[76.69, 11.81], [76.6, 11.74], [76.48, 11.7], [76.37, 11.67]], from: 21, to: 6 },
  { name: 'Bandipur / Mudumalai – NH181 (Gundlupet ↔ Theppakadu)', line: [[76.69, 11.81], [76.63, 11.66], [76.58, 11.57]], from: 21, to: 6 },
  { name: 'Nagarhole (Hunsur ↔ Kutta)', line: [[76.29, 12.31], [76.2, 12.15], [76.13, 12.03], [76.03, 11.95]], from: 18, to: 6 },
  { name: 'Sathyamangalam – NH948 (Bannari ↔ Hasanur, Dhimbam ghat)', line: [[77.13, 11.55], [77.2, 11.6], [77.24, 11.67]], from: 18, to: 6 },
];

const inWindow = (h: number, from: number, to: number) => (from > to ? h >= from || h < to : h >= from && h < to);

class Compliance {
  settings: CompSettings = DEFAULT_COMP;
  alerts = new Map<AlertKind, CompAlert>();
  halt: { c: LngLat; since: number } | null = null;
  version = 0;
  private listeners = new Set<() => void>();
  private lastSaid = new Map<string, number>();
  private overSince = 0;
  private lastCheck = 0;

  subscribe(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  private emit() { this.version++; this.listeners.forEach((f) => f()); }
  async load() {
    this.settings = { ...DEFAULT_COMP, ...(await getSetting('compliance', DEFAULT_COMP)) };
    this.halt = await getSetting('halt', null);
  }
  async setSettings(p: Partial<CompSettings>) { this.settings = { ...this.settings, ...p }; await putSetting('compliance', this.settings); this.emit(); }

  private set(kind: AlertKind, a: Omit<CompAlert, 'kind' | 'at'> | null, speak?: string, repeatMs = 60000) {
    const had = this.alerts.get(kind);
    if (!a) { if (had) { this.alerts.delete(kind); this.emit(); } return; }
    this.alerts.set(kind, { ...a, kind, at: had?.at ?? Date.now() });
    const key = `${kind}:${a.text}`;
    if (speak && Date.now() - (this.lastSaid.get(key) ?? 0) > repeatMs) {
      this.lastSaid.set(key, Date.now());
      if (nav.settings.beep && a.level !== 'info') sounds.offRoute();
      if (nav.settings.voice) say(speak);
    }
    if (!had || had.text !== a.text) this.emit();
  }

  /** Called on every position update while riding live. */
  async onPosition(p: LngLat, speedMps: number, heading: number, sim = false) {
    if (!sim) this.updateHalt(p);
    if (Date.now() - this.lastCheck < 900) return;
    this.lastCheck = Date.now();
    // --- banned expressway underfoot
    const ex = await loadExpressways();
    const h = ex?.idx.nearest(p, 35);
    if (h && speedMps > 3 && isParallel(heading, h.bearing, 30)) {
      this.set('expressway', { level: 'danger', text: `Two-wheelers banned on ${h.road.name} — leave at the next exit` }, `Two wheelers are banned on ${h.road.name}. Leave at the next exit.`, 30000);
    } else this.set('expressway', null);
    // --- speed
    const s = this.settings;
    if (s.speedOn && !sim) {
      const road = this.currentRoadName();
      const nh = /\bNH\b|\bNH ?\d|National Highway/i.test(road);
      const limit = nh ? s.speedNH : s.speedOther;
      const kmh = speedMps * 3.6;
      if (kmh > limit + 3) {
        this.overSince ||= Date.now();
        if (Date.now() - this.overSince > 5000) this.set('speed', { level: 'warn', text: `${Math.round(kmh)} km/h — limit ${limit}${nh ? ' (National Highway)' : ''}` }, `Speed ${Math.round(kmh)}. Limit ${limit}.`, 30000);
      } else { this.overSince = 0; this.set('speed', null); }
    }
    // --- permit zones (here, or within the next 30 km of the route)
    if (s.permitOn) await this.checkPermits(p);
    // --- night closures within the next ~80 km, if you'd reach them while closed
    if (s.nightOn) this.checkNight(p);
  }

  private currentRoadName(): string {
    const L = nav.line;
    if (!L) return '';
    let name = '';
    for (const t of L.turns) { if (t.s > nav.s) break; name = t.n ?? t.txt ?? name; }
    return name;
  }

  private async checkPermits(p: LngLat) {
    await loadStates();
    const ilp = statePolygons().filter((x) => ILP_STATES.includes(x.name));
    const inside = (q: LngLat) => ilp.find((x) => x.polys.some((poly) => pointInPolygon(q, poly)))?.name
      ?? PERMIT_AREAS.find((a) => haversine(q, a.c) <= a.rKm * 1000)?.name;
    const here = inside(p);
    if (here) { this.set('permit', { level: 'warn', text: `In permit area: ${here} — carry your ILP / permit` }, `You are in a permit area, ${here}. Carry your permit.`, 30 * 60000); return; }
    const L = nav.line;
    if (L) for (let d = 1000; d <= 30000; d += 1000) {
      const q = pointAt(L, nav.s + d).p;
      const z = inside(q);
      if (z) { this.set('permit', { level: 'info', text: `Permit area ahead in ${Math.round(d / 1000)} km: ${z}` }, `Permit area ahead in ${Math.round(d / 1000)} kilometres: ${z}.`, 30 * 60000); return; }
      if (nav.s + d > L.total) break;
    }
    this.set('permit', null);
  }

  private checkNight(p: LngLat) {
    const L = nav.line;
    if (!L) return;
    const v = Math.max(nav.speedMps, 40 / 3.6);
    for (let d = 0; d <= 80000 && nav.s + d <= L.total; d += 1000) {
      const q = pointAt(L, nav.s + d).p;
      for (const c of NIGHT_CLOSURES) {
        if (!c.line.some((pt, i) => i < c.line.length - 1 && segDistM(q, pt, c.line[i + 1]) < 1500)) continue;
        const arrive = new Date(Date.now() + (d / v) * 1000);
        const hr = arrive.getHours() + arrive.getMinutes() / 60;
        if (inWindow(hr, c.from, c.to)) {
          const t = arrive.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
          this.set('night', { level: 'danger', text: `${c.name} is closed ${c.from}:00–${String(c.to).padStart(2, '0')}:00 — you'd arrive ~${t}` }, `Warning. ${c.name.split(' (')[0]} is closed at night. You would arrive around ${t}.`, 15 * 60000);
          return;
        }
      }
      void p;
    }
    this.set('night', null);
  }

  // ---------------------------------------------------------------- 48-hour halt
  /** Any trustworthy position (riding or not) moves or keeps the halt anchor. */
  updateHalt(p: LngLat) {
    const r = this.settings.haltRadiusKm * 1000;
    if (!this.halt || haversine(this.halt.c, p) > r) {
      this.halt = { c: p, since: Date.now() };
      void putSetting('halt', this.halt);
      this.set('halt', null);
      return;
    }
    this.checkHalt();
  }
  /** Seconds left before the maximum halt is exceeded (null when not halted long enough to matter). */
  get haltLeftS() {
    if (!this.halt) return null;
    const stayed = (Date.now() - this.halt.since) / 1000;
    if (stayed < 2 * 3600) return null;
    return this.settings.haltHours * 3600 - stayed;
  }
  checkHalt() {
    const left = this.haltLeftS;
    if (left === null || !isExpedition()) { this.set('halt', null); return; }
    const h = left / 3600;
    const lvl = h <= 1 ? 'danger' : h <= 12 ? 'warn' : 'info';
    const text = left <= 0 ? `Maximum halt of ${this.settings.haltHours} h exceeded here` : `Halt here: ${fmtHms(left)} left of ${this.settings.haltHours} h`;
    const milestone = left <= 0 ? 'over' : h <= 1 ? '1h' : h <= 4 ? '4h' : h <= 12 ? '12h' : h <= 24 ? '24h' : '';
    this.set('halt', { level: lvl, text }, milestone ? (left <= 0 ? 'Maximum halt time exceeded.' : `Halt time left: ${Math.ceil(h)} hours.`) : undefined, 6 * 3600000);
  }
}

function segDistM(p: LngLat, a: LngLat, b: LngLat) {
  const k = Math.cos(p[1] * Math.PI / 180) * 111320, ky = 110540;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
export const fmtHms = (s: number) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`; };

export const compliance = new Compliance();

/** Wire the monitor to live navigation, and keep the halt timer ticking. */
export function startCompliance() {
  void compliance.load();
  let last = '';
  nav.subscribe(() => {
    if (nav.mode === 'off' || !nav.pos) return;
    const k = `${nav.pos[0].toFixed(5)},${nav.pos[1].toFixed(5)}`;
    if (k === last) return;
    last = k;
    // simulation checks the route too (expressway, permit, night closure) so problems show up at the desk
    void compliance.onPosition(nav.pos, nav.mode === 'sim' ? 10 : nav.speedMps, nav.heading, nav.mode === 'sim');
  });
  setInterval(() => compliance.checkHalt(), 30000);
  // keep the halt anchor current while the app is open but not navigating
  const poll = async () => {
    if (nav.mode !== 'off' || !isExpedition()) return;
    try {
      const st = await (navigator as any).permissions?.query({ name: 'geolocation' });
      if (st && st.state !== 'granted') return;
      const f = await myFix();
      if (!fixProblem(f) && f.acc <= 200) compliance.updateHalt(f.p);
    } catch { /* no GPS */ }
  };
  setTimeout(poll, 3000);
  setInterval(poll, 10 * 60000);
  void engine;
}
