import { db } from './db';
import { decode6, encode6, lineLength, type LngLat } from './geo';
import { cacheKey, engine, type RouteEngine } from './engine';
import { osrmTurn, valhallaTurn, type Turn } from './turns';

/** Global routing preferences (set from app settings). */
export const routing = { avoidExpressways: true };

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
      try { j = await getJSON(`${base}/route/v1/${profile}/${coords}?${q}${routing.avoidExpressways ? '&exclude=motorway' : ''}`, { signal }); }
      catch (e) { if (routing.avoidExpressways && e instanceof HttpError && e.status === 400 && /exclude|InvalidValue/i.test(e.message)) j = await getJSON(`${base}/route/v1/${profile}/${coords}?${q}`, { signal }); else throw e; }
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
        costing_options: { motorcycle: { use_highways: routing.avoidExpressways ? 0 : 0.5 } },
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
  private listeners = new Set<() => void>();

  constructor(provider: Provider, private eng: RouteEngine = engine) {
    this.setProviders([provider]);
    eng.subscribe(() => this.kick());
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.eng.retryErrors(); this.kick(); });
    }
  }

  /** Primary provider (used for nearest-road snapping). */
  get provider() { return this.workers[0].provider; }
  get providerLabels() { return this.workers.map((w) => w.provider.label); }

  onStatus(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private set(s: RouterStatus) { if (this.status !== s) { this.status = s; this.listeners.forEach((f) => f()); } }
  private refresh() {
    if (!this.autoRoute) return this.set('paused');
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
        if (!this.autoRoute || (typeof navigator !== 'undefined' && navigator.onLine === false)) { w.state = 'idle'; this.refresh(); return; }
        const wait = Math.max(w.backoffMs, w.provider.minIntervalMs - (Date.now() - w.lastAt));
        if (wait > 0) { w.state = w.backoffMs ? 'backoff' : 'routing'; this.refresh(); await this.sleep(w, wait); continue; }
        let run = this.eng.nextPendingRun(w.maxLegs, this.inflight);
        if (!run.length) { w.state = 'idle'; this.refresh(); return; }
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
          const legs = await w.provider.route(points, ctl.signal);
          w.backoffMs = 0; this.lastError = '';
          const rows = run.map((l, i) => ({ l, r: legs[i] })).filter((x) => x.r && x.r.coords.length >= 2);
          await db.legs.bulkPut(rows.map(({ l, r }) => ({ key: cacheKey(l.from, l.to), poly: encode6(r.coords), distM: r.distM, turns: r.turns, provider: w.provider.id, at: Date.now() })));
          run.forEach((l, i) => {
            this.solo.delete(l.key);
            const r = legs[i];
            if (r && r.coords.length >= 2) this.eng.setLegGeometry(l.key, r.coords, r.distM, 'ok', r.turns);
            else this.eng.setLegGeometry(l.key, null, 0, 'error');
          });
        } catch (e: any) {
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
