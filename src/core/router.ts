import { db } from './db';
import { decode6, encode6, lineLength, type LngLat } from './geo';
import { cacheKey, engine, type RouteEngine } from './engine';
import { osrmTurn, valhallaTurn, type Turn } from './turns';

/** Global routing preferences (set from app settings). */
export const routing: {
  avoidExpressways: boolean; covers?: (p: LngLat) => boolean; isDaily?: () => boolean;
  /** Daily mode: route options (tolls, ferries, unpaved, shortest…) and roads the rider chose to avoid */
  dailyOpts?: () => DailyRouteOpts | null; avoidSegs?: () => number[] | undefined; avoidBorders?: () => boolean;
  /** Daily + online + Google key/allowance + options Google can honour → Google plans the legs */
  preferGoogle?: () => boolean;
} = { avoidExpressways: true };
export interface DailyRouteOpts { avoidToll: boolean; avoidFerry: boolean; avoidUnpaved: boolean; avoidMotorway: boolean; shortest: boolean }
/** Keep off two-wheeler-banned expressways? (expedition trips only — daily trips may use them) */
export const avoidingBanned = () => routing.avoidExpressways && !routing.isDaily?.();

export interface LegResult { coords: LngLat[]; distM: number; turns?: Turn[] }
export interface Provider {
  id: string;
  label: string;
  maxWaypoints: number;
  minIntervalMs: number;
  route(points: LngLat[], signal: AbortSignal): Promise<LegResult[]>;
  nearest(p: LngLat): Promise<LngLat | null>;
}

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function getJSON(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = j.code ? ` ${j.code}${j.message ? ': ' + j.message : ''}` : j.error ? ` ${j.error}` : ''; } catch { /* not JSON */ }
    throw new HttpError(r.status, `HTTP ${r.status}${detail}`);
  }
  return r.json();
}

/** Concatenate step geometries into one continuous Polyline6 leg (no duplicated joints) + its turns. */
function joinSteps(steps: any[]): { coords: LngLat[]; turns: Turn[] } {
  const out: LngLat[] = [];
  const turns: Turn[] = [];
  for (const st of steps) {
    const pts = decode6(st.geometry);
    let startIdx = out.length;
    for (let i = 0; i < pts.length; i++) {
      const last = out[out.length - 1];
      if (last && last[0] === pts[i][0] && last[1] === pts[i][1]) { if (i === 0) startIdx = out.length - 1; continue; }
      out.push(pts[i]);
    }
    const t = osrmTurn(st, Math.max(0, startIdx));
    if (t) turns.push(t);
  }
  return { coords: out, turns };
}

const isPublic = (u: string) => /project-osrm\.org|openstreetmap\.de/.test(u);
export const OSRM_PUBLIC = 'https://router.project-osrm.org';
export const OSRM_FOSSGIS = 'https://routing.openstreetmap.de/routed-car';

export function osrmProvider(base = 'https://router.project-osrm.org', profile = 'driving'): Provider {
  return {
    id: `osrm:${base}`,
    label: base.includes('project-osrm.org') ? 'OSRM public' : base.includes('routing.openstreetmap.de') ? 'OSRM FOSSGIS' : `OSRM ${base}`,
    maxWaypoints: 100,
    minIntervalMs: isPublic(base) ? 1100 : 0,
    async route(points, signal) {
      const coords = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
      // two-wheelers are banned on Indian motorways/expressways → exclude them (falls back if a server can't)
      const q = `overview=false&steps=true&geometries=polyline6&continue_straight=false`;
      let j: any;
      const d = routing.dailyOpts?.();
      if (d) {
        // Daily route options: try every requested exclusion, then fewer (public servers accept only some combinations)
        const ex = [d.avoidMotorway && 'motorway', d.avoidToll && 'toll', d.avoidFerry && 'ferry'].filter(Boolean) as string[];
        const tries = ex.length ? [ex, ...ex.map((x) => [x]), []] : [[]];
        let last: unknown;
        for (const t of tries) {
          try { j = await getJSON(`${base}/route/v1/${profile}/${coords}?${q}${t.length ? `&exclude=${t.join(',')}` : ''}`, { signal }); break; }
          catch (e) { last = e; if (!(e instanceof HttpError && e.status === 400)) throw e; }
        }
        if (!j) throw last;
      } else {
        try { j = await getJSON(`${base}/route/v1/${profile}/${coords}?${q}${avoidingBanned() ? '&exclude=motorway' : ''}`, { signal }); }
        catch (e) { if (avoidingBanned() && e instanceof HttpError && e.status === 400 && /exclude|InvalidValue/i.test(e.message)) j = await getJSON(`${base}/route/v1/${profile}/${coords}?${q}`, { signal }); else throw e; }
      }
      if (j.code !== 'Ok') throw new HttpError(422, j.message || j.code);
      return j.routes[0].legs.map((leg: any) => {
        const { coords: c, turns } = joinSteps(leg.steps);
        return { coords: c, distM: leg.distance ?? lineLength(c), turns };
      });
    },
    async nearest(p) {
      try {
        const j = await getJSON(`${base}/nearest/v1/${profile}/${p[0].toFixed(6)},${p[1].toFixed(6)}?number=1`);
        return j.code === 'Ok' && j.waypoints?.[0] ? (j.waypoints[0].location as LngLat) : null;
      } catch { return null; }
    },
  };
}

/** Valhalla motorcycle costing; `excludePolygons` lets us hard-block banned expressways (Phase 3). */
export function valhallaProvider(base = 'https://valhalla1.openstreetmap.de', excludePolygons: LngLat[][] = []): Provider {
  return {
    id: `valhalla:${base}`,
    label: base.includes('openstreetmap.de') ? 'Valhalla public (motorcycle)' : `Valhalla ${base}`,
    maxWaypoints: 20,
    minIntervalMs: isPublic(base) ? 1100 : 0,
    async route(points, signal) {
      const body = {
        locations: points.map(([lon, lat]) => ({ lon, lat, type: 'break' })),
        costing: 'motorcycle',
        costing_options: { motorcycle: dailyCosting() ?? { use_highways: avoidingBanned() ? 0 : 0.5 } },
        directions_type: 'maneuvers',
        ...(excludePolygons.length ? { exclude_polygons: excludePolygons } : {}),
      };
      const j = await getJSON(`${base}/route`, { method: 'POST', body: JSON.stringify(body), signal, headers: { 'Content-Type': 'application/json' } });
      return j.trip.legs.map((leg: any) => {
        const c = decode6(leg.shape);
        const turns = (leg.maneuvers ?? []).map(valhallaTurn).filter(Boolean) as Turn[];
        return { coords: c, distM: (leg.summary?.length ?? 0) * 1000 || lineLength(c), turns };
      });
    },
    async nearest(p) {
      try {
        const j = await getJSON(`${base}/locate`, { method: 'POST', body: JSON.stringify({ locations: [{ lon: p[0], lat: p[1] }], costing: 'motorcycle', verbose: false }) });
        const e = j?.[0]?.edges?.[0];
        return e ? ([e.correlated_lon, e.correlated_lat] as LngLat) : null;
      } catch { return null; }
    },
  };
}

/** Valhalla motorcycle costing for Daily route options (null outside Daily mode). */
export function dailyCosting() {
  const d = routing.dailyOpts?.();
  if (!d) return null;
  return { use_highways: d.avoidMotorway ? 0 : 0.5, use_tolls: d.avoidToll ? 0 : 0.5, use_ferry: d.avoidFerry ? 0 : 0.5, exclude_unpaved: d.avoidUnpaved, shortest: d.shortest, ...(routing.avoidBorders?.() ? { country_crossing_penalty: 7200, country_crossing_cost: 1800 } : {}) };
}

/** Polygons around roads the Daily rider marked "avoid" near a leg (for Valhalla exclude_polygons). */
function avoidedPolygons(from: LngLat, to: LngLat, widthM = 20): LngLat[][] {
  const segs = routing.avoidSegs?.() ?? [];
  const pad = 0.1, box = [Math.min(from[0], to[0]) - pad, Math.min(from[1], to[1]) - pad, Math.max(from[0], to[0]) + pad, Math.max(from[1], to[1]) + pad];
  const out: LngLat[][] = [];
  for (let i = 0; i < segs.length; i += 4) {
    const a: LngLat = [segs[i], segs[i + 1]], b: LngLat = [segs[i + 2], segs[i + 3]];
    if (Math.max(a[0], b[0]) < box[0] || Math.min(a[0], b[0]) > box[2] || Math.max(a[1], b[1]) < box[1] || Math.min(a[1], b[1]) > box[3]) continue;
    const kx = Math.cos(a[1] * Math.PI / 180) * 111320, ky = 110540;
    let dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky; const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const ox = (-dy * widthM) / kx, oy = (dx * widthM) / ky;
    out.push([[a[0] + ox, a[1] + oy], [b[0] + ox, b[1] + oy], [b[0] - ox, b[1] - oy], [a[0] - ox, a[1] - oy], [a[0] + ox, a[1] + oy]]);
    if (out.length >= 60) break;
  }
  return out;
}

/** Does a leg run along a road the Daily rider chose to avoid (≥ 50 m within 15 m)? */
export function legOnAvoided(coords: LngLat[]): boolean {
  const segs = routing.avoidSegs?.() ?? [];
  if (!segs.length) return false;
  let run = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const kx = Math.cos(a[1] * Math.PI / 180) * 111320, ky = 110540;
    const m = Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
    let near = false;
    for (let k = 0; k < segs.length && !near; k += 4) {
      const ax = (segs[k] - a[0]) * kx, ay = (segs[k + 1] - a[1]) * ky, bx = (segs[k + 2] - a[0]) * kx, by = (segs[k + 3] - a[1]) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      near = Math.hypot(ax + t * dx, ay + t * dy) < 15;
    }
    if (near) { run += m; if (run >= 50) return true; } else run = 0;
  }
  return false;
}

/** Valhalla motorcycle (honours "no motorcycles") with banned roads near the leg blocked out. */
async function routeAvoidingBanned(from: LngLat, to: LngLat, signal: AbortSignal): Promise<LegResult> {
  const { bannedPolygonsNear } = await import('../nav/expressways');
  const daily = routing.dailyOpts?.();
  // Daily: block the roads the rider chose to avoid (expressways are allowed there); expedition: banned roads
  const polys = daily ? avoidedPolygons(from, to) : await bannedPolygonsNear(from, to);
  const j = await getJSON('https://valhalla1.openstreetmap.de/route', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: [{ lon: from[0], lat: from[1] }, { lon: to[0], lat: to[1] }], costing: 'motorcycle', directions_type: 'maneuvers',
      costing_options: { motorcycle: dailyCosting() ?? { use_highways: 0 } }, ...(polys.length ? { exclude_polygons: polys } : {}) }),
  });
  const leg = j.trip.legs[0];
  const c = decode6(leg.shape);
  return { coords: c, distM: (leg.summary?.length ?? 0) * 1000 || lineLength(c), turns: (leg.maneuvers ?? []).map(valhallaTurn).filter(Boolean) as Turn[] };
}

export type RouterStatus = 'idle' | 'routing' | 'offline' | 'paused' | 'backoff';

interface Worker {
  provider: Provider;
  maxLegs: number;      // adaptive: halves if the server says a batch is too big
  lastAt: number;
  backoffMs: number;
  state: 'idle' | 'routing' | 'backoff';
  running: boolean;
  wake: (() => void) | null;
}

/**
 * Paced, cache-first routing queue. Every computed leg is stored in IndexedDB keyed by its exact
 * endpoints, so adding new pins never re-fetches old segments. Several free servers can work in
 * parallel, each paced to its own fair-use limit; workers never take the same legs.
 */
export class RoutingQueue {
  status: RouterStatus = 'idle';
  autoRoute = true;
  lastError = '';
  requests = 0;
  private workers: Worker[] = [];
  private inflight = new Set<string>();
  private solo = new Set<string>();
  /** legs whose first route used a two-wheeler-banned road → re-route them avoiding banned roads */
  private avoid = new Set<string>();
  private avoidTried = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(provider: Provider, private eng: RouteEngine = engine) {
    this.setProviders([provider]);
    eng.subscribe(() => this.kick());
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.eng.retryErrors(); this.kick(); });
    }
  }

  /** Primary provider (first in the pool — the on-device router when present). */
  get provider() { return this.workers[0].provider; }
  /** First internet routing server (for points outside downloaded regions). */
  get netProvider() { return (this.workers.find((w) => w.provider.id !== 'device') ?? this.workers[0]).provider; }
  /** Best provider for these points: on-device when they're inside downloaded regions. */
  providerFor(points: LngLat[]) {
    const dev = this.workers.find((w) => w.provider.id === 'device');
    return dev && routing.covers && points.every((p) => routing.covers!(p)) ? dev.provider : this.netProvider;
  }
  get providerLabels() { return this.workers.map((w) => w.provider.label); }

  onStatus(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private set(s: RouterStatus) { if (this.status !== s) { this.status = s; this.listeners.forEach((f) => f()); } }
  private refresh() {
    if (!this.autoRoute) return this.set('paused');
    if (this.workers.some((w) => w.provider.id === 'device' && w.state === 'routing')) return this.set('routing');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return this.set('offline');
    if (this.workers.some((w) => w.state === 'routing')) return this.set('routing');
    if (this.workers.some((w) => w.state === 'backoff')) return this.set('backoff');
    this.set('idle');
  }

  setProvider(p: Provider) { this.setProviders([p]); }
  setProviders(ps: Provider[]) {
    this.workers.forEach((w) => w.wake?.());
    this.workers = ps.map((provider) => ({ provider, maxLegs: provider.maxWaypoints - 1, lastAt: 0, backoffMs: 0, state: 'idle', running: false, wake: null }));
    this.kick();
  }
  setAuto(on: boolean) { this.autoRoute = on; if (on) this.kick(); else this.refresh(); }

  /** Expected throughput in legs per second across all servers. */
  legsPerSec() {
    return this.workers.reduce((a, w) => a + w.maxLegs / (Math.max(w.provider.minIntervalMs, 400) / 1000), 0);
  }

  kick() {
    for (const w of this.workers) {
      if (w.wake) { const f = w.wake; w.wake = null; f(); }
      if (!w.running) void this.loop(w);
    }
  }

  private sleep(w: Worker, ms: number) {
    return new Promise<void>((res) => { const t = setTimeout(() => { w.wake = null; res(); }, ms); w.wake = () => { clearTimeout(t); res(); }; });
  }

  private async loop(w: Worker) {
    w.running = true;
    try {
      for (;;) {
        if (!this.workers.includes(w)) return;
        // offline: internet servers pause, the on-device router keeps working
        if (!this.autoRoute || (w.provider.id !== 'device' && typeof navigator !== 'undefined' && navigator.onLine === false)) { w.state = 'idle'; this.refresh(); return; }
        const wait = Math.max(w.backoffMs, w.provider.minIntervalMs - (Date.now() - w.lastAt));
        if (wait > 0) { w.state = w.backoffMs ? 'backoff' : 'routing'; this.refresh(); await this.sleep(w, wait); continue; }
        // Daily with Google: only the Google worker routes; otherwise the Google worker stays idle
        const g = routing.preferGoogle?.() ?? false;
        if ((w.provider.id === 'google') !== g) { w.state = 'idle'; this.refresh(); return; }
        // legs inside downloaded regions go to the on-device router, the rest to internet servers
        const local = w.provider.id === 'device';
        const covered = (l: { from: LngLat; to: LngLat }) => !!routing.covers && routing.covers(l.from) && routing.covers(l.to);
        const hasLocal = this.workers.some((x) => x.provider.id === 'device');
        let run = this.eng.nextPendingRun(w.maxLegs, this.inflight, local ? covered : hasLocal && !g ? (l) => !covered(l) : undefined);
        if (!run.length) { w.state = 'idle'; this.refresh(); return; }
        if (!local && run.some((l) => this.avoid.has(l.key))) run = [run.find((l) => this.avoid.has(l.key))!];
        const si = run.findIndex((l) => this.solo.has(l.key));
        if (si === 0) run = [run[0]]; else if (si > 0) run = run.slice(0, si);
        w.state = 'routing'; this.refresh();
        run.forEach((l) => this.inflight.add(l.key));
        const points: LngLat[] = [run[0].from, ...run.map((l) => l.to)];
        w.lastAt = Date.now();
        this.requests++;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 30000);
        try {
          const safe = run.length === 1 && this.avoid.has(run[0].key);
          const legs = safe ? [await routeAvoidingBanned(points[0], points[1], ctl.signal)] : await w.provider.route(points, ctl.signal);
          if (safe) { this.avoid.delete(run[0].key); this.avoidTried.add(run[0].key); }
          // never accept a route along a two-wheeler-banned expressway: send it back for an avoiding re-route
          const { legOnBanned } = await import('../nav/expressways');
          if (avoidingBanned()) for (let i = 0; i < run.length; i++) {
            const r = legs[i];
            if (r && !this.avoidTried.has(run[i].key) && (await legOnBanned(r.coords))) { this.avoid.add(run[i].key); legs[i] = undefined as any; }
          }
          // Daily: roads the rider chose to avoid → send the leg back for a re-route around them
          if (routing.dailyOpts?.()) for (let i = 0; i < run.length; i++) {
            const r = legs[i];
            if (r && !this.avoidTried.has(run[i].key) && legOnAvoided(r.coords)) { this.avoid.add(run[i].key); legs[i] = undefined as any; }
          }
          w.backoffMs = 0; this.lastError = '';
          const rows = run.map((l, i) => ({ l, r: legs[i] })).filter((x) => x.r && x.r.coords.length >= 2);
          const sentBack = run.filter((l, i) => !legs[i] && this.avoid.has(l.key));
          await db.legs.bulkPut(rows.map(({ l, r }) => ({ key: cacheKey(l.from, l.to), poly: encode6(r.coords), distM: r.distM, turns: r.turns, provider: w.provider.id, at: Date.now() })));
          run.forEach((l, i) => {
            this.solo.delete(l.key);
            const r = legs[i];
            if (r && r.coords.length >= 2) this.eng.setLegGeometry(l.key, r.coords, r.distM, 'ok', r.turns);
            else if (!sentBack.includes(l)) this.eng.setLegGeometry(l.key, null, 0, 'error');
          });
        } catch (e: any) {
          if ((e as any)?.offline) { w.state = 'idle'; continue; } // device can't route these: leave them pending for the servers
          const status = e instanceof HttpError ? e.status : 0;
          this.lastError = `${w.provider.label}: ${e?.message || String(e)}`;
          if (status === 413 || status === 414 || /TooBig/i.test(e?.message || '')) {
            w.maxLegs = Math.max(4, Math.floor(w.maxLegs / 2)); // server wants smaller batches
          } else if (status === 429 || status >= 500 || status === 0) {
            // rate-limited / server or network hiccup: exponential backoff on this server only
            w.backoffMs = Math.min(60000, Math.max(2000, w.backoffMs * 2));
          } else if (run.length > 1) {
            // one bad point (e.g. in the sea) poisons the batch: retry this run leg-by-leg
            for (const l of run) this.solo.add(l.key);
          } else {
            this.solo.delete(run[0].key);
            this.eng.setLegGeometry(run[0].key, null, 0, 'error');
          }
        } finally {
          clearTimeout(timer);
          run.forEach((l) => this.inflight.delete(l.key));
        }
      }
    } finally { w.running = false; }
  }
}
