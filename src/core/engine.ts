import { db, uid, type StopTuple, type Trip } from './db';
import { ckey, decode6, haversine, type LngLat } from './geo';
import type { Turn } from './turns';

export interface Stop { id: string; lng: number; lat: number; name?: string }
export type LegStatus = 'ok' | 'pending' | 'error';
export interface Leg {
  key: string; a: string; b: string;
  from: LngLat; to: LngLat;
  coords: LngLat[] | null; distM: number; status: LegStatus;
  turns?: Turn[];
  fid: number; // numeric feature id for MapLibre diff updates
}

/** Commands are stored on disk; each one is its own inverse-able diff. */
export type Cmd =
  | { t: 'ins'; i: number; s: StopTuple[] }
  | { t: 'del'; i: number; s: StopTuple[] }
  | { t: 'mov'; i: number; from: [number, number]; to: [number, number] }
  | { t: 'rep'; before: StopTuple[]; after: StopTuple[] }
  | { t: 'ren'; i: number; from?: string; to?: string };

export interface LegDiff { add: Leg[]; remove: Leg[]; update: Leg[] }

const toTuple = (s: Stop): StopTuple => (s.name ? [s.id, s.lng, s.lat, s.name] : [s.id, s.lng, s.lat]);
const fromTuple = (t: StopTuple): Stop => ({ id: t[0], lng: t[1], lat: t[2], name: t[3] });
export const cacheKey = (a: LngLat, b: LngLat) => `${ckey(a)}|${ckey(b)}`;

function invert(c: Cmd): Cmd {
  switch (c.t) {
    case 'ins': return { t: 'del', i: c.i, s: c.s };
    case 'del': return { t: 'ins', i: c.i, s: c.s };
    case 'mov': return { t: 'mov', i: c.i, from: c.to, to: c.from };
    case 'rep': return { t: 'rep', before: c.after, after: c.before };
    case 'ren': return { t: 'ren', i: c.i, from: c.to, to: c.from };
  }
}

type Listener = (e: { stops: boolean; legs?: LegDiff }) => void;

export class RouteEngine {
  trip: Trip | null = null;
  stops: Stop[] = [];
  legs = new Map<string, Leg>();
  routedM = 0;
  pendingLegs = 0;
  errorLegs = 0;
  version = 0;
  /** Leg keys that should be routed before anything else (e.g. just dragged). */
  priority = new Set<string>();

  private nextFid = 1;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private idx: Map<string, number> | null = null;
  private busy: Promise<unknown> = Promise.resolve();

  subscribe(fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit(stops: boolean, legs?: LegDiff) {
    this.version++;
    for (const l of this.listeners) l({ stops, legs });
  }

  /** Serialize async mutations so rapid taps never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.busy.then(fn, fn);
    this.busy = p.catch(() => undefined);
    return p;
  }

  // ---------- trips ----------
  async loadTrip(tripId: string) {
    await this.flush();
    const trip = await db.trips.get(tripId);
    if (!trip) throw new Error('Trip not found');
    const draft = await db.drafts.get(tripId);
    this.trip = trip;
    this.stops = (draft?.stops ?? []).map(fromTuple);
    await this.reconcile(draft?.cursor);
    const removed = [...this.legs.values()];
    this.legs.clear(); this.routedM = 0; this.pendingLegs = 0; this.errorLegs = 0; this.priority.clear();
    this.idx = null;
    const add = await this.buildLegs(0, this.stops.length - 1);
    this.emit(true, { add, remove: removed, update: [] });
  }

  /**
   * The draft snapshot is written lazily, the history log immediately. If the app closed before the
   * snapshot caught up, replay (or rewind) the logged commands so no edit is ever lost.
   */
  private async reconcile(draftCursor: number | undefined) {
    const t = this.trip!;
    if (draftCursor === undefined || draftCursor === t.historyCursor) return;
    const lo = Math.min(draftCursor, t.historyCursor) + 1, hi = Math.max(draftCursor, t.historyCursor);
    const rows = await db.history.where('[tripId+seq]').between([t.id, lo], [t.id, hi], true, true).sortBy('seq');
    const forward = t.historyCursor > draftCursor;
    for (const h of forward ? rows : rows.reverse()) this.applyStops(forward ? (h.cmd as Cmd) : invert(h.cmd as Cmd));
    await this.flush();
  }

  /** Stop-list-only application of a command (no leg bookkeeping) — used for replay before legs are built. */
  private applyStops(c: Cmd) {
    const S = this.stops;
    if (c.t === 'ins') S.splice(c.i, 0, ...c.s.map(fromTuple));
    else if (c.t === 'del') S.splice(c.i, c.s.length);
    else if (c.t === 'mov') { S[c.i].lng = c.to[0]; S[c.i].lat = c.to[1]; }
    else if (c.t === 'ren') S[c.i].name = c.to;
    else this.stops = c.after.map(fromTuple);
  }

  async updateTrip(patch: Partial<Trip>) {
    if (!this.trip) return;
    Object.assign(this.trip, patch, { updatedAt: Date.now() });
    await db.trips.put(this.trip);
    this.emit(false);
  }

  // ---------- legs ----------
  private legKey(a: Stop, b: Stop) { return `${a.id}>${b.id}|${ckey([a.lng, a.lat])}|${ckey([b.lng, b.lat])}`; }

  /** Keys of legs j..k (leg j joins stop j → j+1). */
  private keysInRange(stops: Stop[], j: number, k: number): string[] {
    const out: string[] = [];
    for (let x = Math.max(0, j); x <= Math.min(k, stops.length - 2); x++) out.push(this.legKey(stops[x], stops[x + 1]));
    return out;
  }

  private accountRemove(l: Leg) {
    if (l.status === 'ok') this.routedM -= l.distM; else if (l.status === 'pending') this.pendingLegs--; else this.errorLegs--;
  }
  private accountAdd(l: Leg) {
    if (l.status === 'ok') this.routedM += l.distM; else if (l.status === 'pending') this.pendingLegs++; else this.errorLegs++;
  }

  /** Create legs for leg indexes j..k, hydrating geometry from the IndexedDB cache. */
  private async buildLegs(j: number, k: number): Promise<Leg[]> {
    const created: Leg[] = [];
    for (let x = Math.max(0, j); x <= Math.min(k, this.stops.length - 2); x++) {
      const a = this.stops[x], b = this.stops[x + 1];
      const key = this.legKey(a, b);
      if (this.legs.has(key)) continue;
      const leg: Leg = { key, a: a.id, b: b.id, from: [a.lng, a.lat], to: [b.lng, b.lat], coords: null, distM: 0, status: 'pending', fid: this.nextFid++ };
      this.legs.set(key, leg);
      created.push(leg);
    }
    if (created.length) {
      const cached = await db.legs.bulkGet(created.map((l) => cacheKey(l.from, l.to)));
      cached.forEach((c, i) => {
        if (c) { const l = created[i]; l.coords = decode6(c.poly); l.distM = c.distM; l.status = 'ok'; l.turns = c.turns; }
      });
      created.forEach((l) => this.accountAdd(l));
    }
    return created;
  }

  /** Replace legs in an old window with the legs in a new window. */
  private async resync(oldKeys: string[], j: number, k: number): Promise<LegDiff> {
    const newKeys = new Set(this.keysInRange(this.stops, j, k));
    const remove: Leg[] = [];
    for (const key of oldKeys) {
      if (newKeys.has(key)) continue;
      const l = this.legs.get(key);
      if (l) { this.legs.delete(key); this.accountRemove(l); this.priority.delete(key); remove.push(l); }
    }
    const add = await this.buildLegs(j, k);
    return { add, remove, update: [] };
  }

  /** Called by the router when a leg's road geometry arrives. */
  setLegGeometry(key: string, coords: LngLat[] | null, distM: number, status: LegStatus, turns?: Turn[]) {
    const l = this.legs.get(key);
    if (!l) return;
    this.accountRemove(l);
    l.coords = coords; l.distM = distM; l.status = status; l.turns = turns;
    this.accountAdd(l);
    this.priority.delete(key);
    this.emit(false, { add: [], remove: [], update: [l] });
  }

  /** Retry legs that failed (e.g. after coming back online). */
  retryErrors() {
    const update: Leg[] = [];
    for (const l of this.legs.values()) if (l.status === 'error') { this.accountRemove(l); l.status = 'pending'; this.accountAdd(l); update.push(l); }
    if (update.length) this.emit(false, { add: [], remove: [], update });
  }

  /** Leg from stop i to stop i+1. */
  legAt(i: number): Leg | undefined {
    const S = this.stops;
    return i >= 0 && i < S.length - 1 ? this.legs.get(this.legKey(S[i], S[i + 1])) : undefined;
  }
  /** Distance along the route to stop i (road distance where routed, estimate otherwise). */
  kmMark(i: number): number {
    let d = 0;
    for (let x = 0; x < i; x++) { const l = this.legAt(x); d += l?.status === 'ok' ? l.distM : l ? haversine(l.from, l.to) * 1.3 : 0; }
    return d;
  }

  indexOf(id: string): number {
    if (!this.idx) { this.idx = new Map(); this.stops.forEach((s, i) => this.idx!.set(s.id, i)); }
    return this.idx.get(id) ?? -1;
  }

  /** Contiguous run of pending legs (for one multi-waypoint request), priority legs first; skips legs already in flight. */
  nextPendingRun(maxLegs: number, skip: Set<string> = new Set()): Leg[] {
    const free = (l: Leg | undefined) => !!l && l.status === 'pending' && !skip.has(l.key);
    let start: Leg | undefined;
    for (const key of this.priority) { const l = this.legs.get(key); if (free(l)) { start = l; break; } }
    if (!start) for (const l of this.legs.values()) if (free(l)) { start = l; break; }
    if (!start) return [];
    let i = this.indexOf(start.a);
    if (!this.priority.has(start.key)) {
      // walk back to the start of the free pending run so requests stay contiguous
      while (i > 0 && free(this.legs.get(this.legKey(this.stops[i - 1], this.stops[i])))) i--;
    }
    const run: Leg[] = [];
    for (let x = i; x < this.stops.length - 1 && run.length < maxLegs; x++) {
      const l = this.legs.get(this.legKey(this.stops[x], this.stops[x + 1]));
      if (!free(l)) break;
      run.push(l!);
    }
    return run;
  }

  // ---------- commands ----------
  private async apply(c: Cmd): Promise<LegDiff> {
    const S = this.stops;
    this.idx = null;
    switch (c.t) {
      case 'ins': {
        const old = this.keysInRange(S, c.i - 1, c.i - 1);
        S.splice(c.i, 0, ...c.s.map(fromTuple));
        return this.resync(old, c.i - 1, c.i + c.s.length - 1);
      }
      case 'del': {
        const old = this.keysInRange(S, c.i - 1, c.i + c.s.length - 1);
        S.splice(c.i, c.s.length);
        return this.resync(old, c.i - 1, c.i - 1);
      }
      case 'mov': {
        const old = this.keysInRange(S, c.i - 1, c.i);
        const s = S[c.i]; s.lng = c.to[0]; s.lat = c.to[1];
        const d = await this.resync(old, c.i - 1, c.i);
        d.add.forEach((l) => this.priority.add(l.key));
        return d;
      }
      case 'ren': { S[c.i].name = c.to; return { add: [], remove: [], update: [] }; }
      case 'rep': {
        const remove = [...this.legs.values()];
        this.legs.clear(); this.routedM = 0; this.pendingLegs = 0; this.errorLegs = 0; this.priority.clear();
        this.stops = c.after.map(fromTuple);
        const add = await this.buildLegs(0, this.stops.length - 1);
        return { add, remove, update: [] };
      }
    }
  }

  exec(c: Cmd) {
    return this.serial(async () => {
      if (!this.trip) throw new Error('No trip loaded');
      const diff = await this.apply(c);
      const t = this.trip;
      const seq = t.historyCursor + 1;
      await db.transaction('rw', db.history, db.trips, async () => {
        if (t.historyTop > t.historyCursor) await db.history.where('[tripId+seq]').between([t.id, seq], [t.id, Infinity]).delete();
        await db.history.add({ tripId: t.id, seq, cmd: c });
        t.historyCursor = seq; t.historyTop = seq; t.updatedAt = Date.now();
        await db.trips.put(t);
      });
      this.scheduleSave();
      this.emit(true, diff);
    });
  }

  get canUndo() { return !!this.trip && this.trip.historyCursor > 0; }
  get canRedo() { return !!this.trip && this.trip.historyTop > this.trip.historyCursor; }

  undo() { return this.step(-1); }
  redo() { return this.step(1); }
  private step(dir: 1 | -1) {
    return this.serial(async () => {
      const t = this.trip;
      if (!t) return;
      const seq = dir < 0 ? t.historyCursor : t.historyCursor + 1;
      if (seq < 1 || seq > t.historyTop) return;
      const h = await db.history.where('[tripId+seq]').equals([t.id, seq]).first();
      if (!h) return;
      const c = h.cmd as Cmd;
      const diff = await this.apply(dir < 0 ? invert(c) : c);
      t.historyCursor = dir < 0 ? seq - 1 : seq;
      await db.trips.put(t);
      this.scheduleSave();
      this.emit(true, diff);
    });
  }

  // ---------- high level edits ----------
  addStop(p: LngLat, index = this.stops.length, name?: string) {
    const t: StopTuple = name ? [uid(), p[0], p[1], name] : [uid(), p[0], p[1]];
    return this.exec({ t: 'ins', i: Math.max(0, Math.min(index, this.stops.length)), s: [t] });
  }
  addMany(points: { p: LngLat; name?: string }[], index = this.stops.length) {
    if (!points.length) return Promise.resolve();
    const s: StopTuple[] = points.map(({ p, name }) => (name ? [uid(), p[0], p[1], name] : [uid(), p[0], p[1]]));
    return this.exec({ t: 'ins', i: index, s });
  }
  /** Insert a stop on an existing leg (between its two stops). */
  insertOnLeg(legKey: string, p: LngLat) {
    const l = this.legs.get(legKey);
    if (!l) return this.addStop(p);
    return this.addStop(p, this.indexOf(l.a) + 1);
  }
  moveStop(id: string, p: LngLat) {
    const i = this.indexOf(id);
    if (i < 0) return Promise.resolve();
    const s = this.stops[i];
    return this.exec({ t: 'mov', i, from: [s.lng, s.lat], to: p });
  }
  deleteStop(id: string) {
    const i = this.indexOf(id);
    if (i < 0) return Promise.resolve();
    return this.exec({ t: 'del', i, s: [toTuple(this.stops[i])] });
  }
  deleteAt(i: number) { const s = this.stops[i]; return s ? this.deleteStop(s.id) : Promise.resolve(); }
  renameStop(id: string, name?: string) {
    const i = this.indexOf(id);
    if (i < 0) return Promise.resolve();
    return this.exec({ t: 'ren', i, from: this.stops[i].name, to: name || undefined });
  }
  replaceAll(stops: Stop[]) {
    return this.exec({ t: 'rep', before: this.stops.map(toTuple), after: stops.map(toTuple) });
  }
  reverse() {
    if (this.trip?.sequenceLock) return Promise.reject(new Error('Sequence Lock is on — unlock it to reverse.'));
    return this.replaceAll(this.stops.slice().reverse());
  }
  clear() { return this.replaceAll([]); }

  // ---------- persistence ----------
  snapshot(): StopTuple[] { return this.stops.map(toTuple); }
  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 600);
  }
  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.trip) return;
    await db.drafts.put({ tripId: this.trip.id, stops: this.snapshot(), updatedAt: Date.now(), cursor: this.trip.historyCursor });
  }

  /** Total planned distance including straight-line estimate for legs not yet routed. */
  estimateM() {
    let est = this.routedM;
    for (const l of this.legs.values()) if (l.status !== 'ok') est += haversine(l.from, l.to) * 1.3;
    return est;
  }
}

export const engine = new RouteEngine();
