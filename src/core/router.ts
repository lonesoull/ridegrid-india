import { db } from './db';
import { decode6, encode6, lineLength, type LngLat } from './geo';
import { cacheKey, engine, type RouteEngine } from './engine';

export interface LegResult { coords: LngLat[]; distM: number }
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
  if (!r.ok) throw new HttpError(r.status, `HTTP ${r.status}`);
  return r.json();
}

/** Concatenate step geometries into one continuous Polyline6 leg (no duplicated joints). */
function joinSteps(steps: { geometry: string }[]): LngLat[] {
  const out: LngLat[] = [];
  for (const st of steps) {
    const pts = decode6(st.geometry);
    for (let i = 0; i < pts.length; i++) {
      const last = out[out.length - 1];
      if (last && last[0] === pts[i][0] && last[1] === pts[i][1]) continue;
      out.push(pts[i]);
    }
  }
  return out;
}

export function osrmProvider(base = 'https://router.project-osrm.org', profile = 'driving'): Provider {
  return {
    id: `osrm:${base}`,
    label: base.includes('project-osrm.org') ? 'OSRM public' : `OSRM ${base}`,
    maxWaypoints: 25,
    minIntervalMs: base.includes('project-osrm.org') ? 1100 : 0,
    async route(points, signal) {
      const coords = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
      const j = await getJSON(`${base}/route/v1/${profile}/${coords}?overview=false&steps=true&geometries=polyline6&continue_straight=false`, { signal });
      if (j.code !== 'Ok') throw new HttpError(422, j.message || j.code);
      return j.routes[0].legs.map((leg: any) => {
        const c = joinSteps(leg.steps);
        return { coords: c, distM: leg.distance ?? lineLength(c) };
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
    minIntervalMs: base.includes('openstreetmap.de') ? 1100 : 0,
    async route(points, signal) {
      const body = {
        locations: points.map(([lon, lat]) => ({ lon, lat, type: 'break' })),
        costing: 'motorcycle',
        costing_options: { motorcycle: { use_highways: 0.5 } },
        directions_type: 'none',
        ...(excludePolygons.length ? { exclude_polygons: excludePolygons } : {}),
      };
      const j = await getJSON(`${base}/route`, { method: 'POST', body: JSON.stringify(body), signal, headers: { 'Content-Type': 'application/json' } });
      return j.trip.legs.map((leg: any) => {
        const c = decode6(leg.shape);
        return { coords: c, distM: (leg.summary?.length ?? 0) * 1000 || lineLength(c) };
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

/**
 * Paced, cache-first routing queue. Every computed leg is stored in IndexedDB keyed by its exact
 * endpoints, so adding new pins never re-fetches old segments and the public servers never see bursts.
 */
export class RoutingQueue {
  status: RouterStatus = 'idle';
  autoRoute = true;
  lastError = '';
  requests = 0;
  private running = false;
  private solo = new Set<string>();
  private lastAt = 0;
  private backoffMs = 0;
  private wake: (() => void) | null = null;
  private listeners = new Set<() => void>();

  constructor(public provider: Provider, private eng: RouteEngine = engine) {
    eng.subscribe(() => this.kick());
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => { this.eng.retryErrors(); this.kick(); });
    }
  }

  onStatus(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private set(s: RouterStatus) { if (this.status !== s) { this.status = s; this.listeners.forEach((f) => f()); } }

  setProvider(p: Provider) { this.provider = p; this.kick(); }
  setAuto(on: boolean) { this.autoRoute = on; if (on) this.kick(); else this.set('paused'); }

  kick() {
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
    if (!this.running) void this.loop();
  }

  private sleep(ms: number) {
    return new Promise<void>((res) => { const t = setTimeout(() => { this.wake = null; res(); }, ms); this.wake = () => { clearTimeout(t); res(); }; });
  }

  private async loop() {
    this.running = true;
    try {
      for (;;) {
        if (!this.autoRoute) { this.set('paused'); return; }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { this.set('offline'); return; }
        let run = this.eng.nextPendingRun(this.provider.maxWaypoints - 1);
        if (!run.length) { this.set('idle'); return; }
        const si = run.findIndex((l) => this.solo.has(l.key));
        if (si === 0) run = [run[0]]; else if (si > 0) run = run.slice(0, si);
        const wait = Math.max(this.backoffMs, this.provider.minIntervalMs - (Date.now() - this.lastAt));
        if (wait > 0) { this.set(this.backoffMs ? 'backoff' : 'routing'); await this.sleep(wait); continue; }
        this.set('routing');
        const points: LngLat[] = [run[0].from, ...run.map((l) => l.to)];
        this.lastAt = Date.now();
        this.requests++;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 30000);
        try {
          const legs = await this.provider.route(points, ctl.signal);
          this.backoffMs = 0; this.lastError = '';
          const rows = run.map((l, i) => ({ l, r: legs[i] })).filter((x) => x.r && x.r.coords.length >= 2);
          await db.legs.bulkPut(rows.map(({ l, r }) => ({ key: cacheKey(l.from, l.to), poly: encode6(r.coords), distM: r.distM, provider: this.provider.id, at: Date.now() })));
          run.forEach((l, i) => {
            this.solo.delete(l.key);
            const r = legs[i];
            if (r && r.coords.length >= 2) this.eng.setLegGeometry(l.key, r.coords, r.distM, 'ok');
            else this.eng.setLegGeometry(l.key, null, 0, 'error');
          });
        } catch (e: any) {
          const status = e instanceof HttpError ? e.status : 0;
          this.lastError = e?.message || String(e);
          if (status === 429 || status >= 500 || status === 0) {
            // rate-limited / server or network hiccup: exponential backoff, keep legs pending
            this.backoffMs = Math.min(60000, Math.max(2000, this.backoffMs * 2));
            if (typeof navigator !== 'undefined' && navigator.onLine === false) { this.set('offline'); return; }
          } else if (run.length > 1) {
            // one bad point (e.g. in the sea) poisons the batch: retry this run leg-by-leg
            for (const l of run) this.solo.add(l.key);
          } else {
            this.solo.delete(run[0].key);
            this.eng.setLegGeometry(run[0].key, null, 0, 'error');
          }
        } finally { clearTimeout(timer); }
      }
    } finally { this.running = false; }
  }
}

export const providers = {
  osrm: (url?: string) => osrmProvider(url || undefined),
  valhalla: (url?: string) => valhallaProvider(url || undefined),
};
