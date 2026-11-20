import { db } from '../core/db';
import type { LngLat } from '../core/geo';
import { avoidingBanned, routing, type Provider, type LegResult } from '../core/router';
import { lanesForTurn, type Turn } from '../core/turns';
import { deriveTurns } from '../nav/detour';

/**
 * On-device router: road graphs for India's zones, downloaded once and stored on the device.
 * Routes in a background thread — no internet, no rate limits.
 */
export interface ZoneInfo { zone: string; label: string; states: string; bytes?: number; km?: number; generated?: string }
export const ZONES: ZoneInfo[] = [
  { zone: 'southern-zone', label: 'South', states: 'Tamil Nadu, Kerala, Karnataka, Andhra Pradesh, Telangana, Puducherry' },
  { zone: 'western-zone', label: 'West', states: 'Maharashtra, Gujarat, Goa, Dadra & Nagar Haveli and Daman & Diu' },
  { zone: 'northern-zone', label: 'North', states: 'Delhi, UP, Haryana, Punjab, Rajasthan, HP, J&K, Ladakh, Uttarakhand, Chandigarh' },
  { zone: 'central-zone', label: 'Central', states: 'Madhya Pradesh, Chhattisgarh' },
  { zone: 'eastern-zone', label: 'East', states: 'West Bengal, Odisha, Bihar, Jharkhand, Andaman & Nicobar' },
  { zone: 'north-eastern-zone', label: 'North-East', states: 'Assam, Arunachal, Nagaland, Manipur, Mizoram, Tripura, Meghalaya, Sikkim' },
];

let worker: Worker | null = null;
let seq = 0;
const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
function call<T = any>(msg: any, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => { const w = waiting.get(ev.data.id); if (!w) return; waiting.delete(ev.data.id); ev.data.ok ? w.res(ev.data) : w.rej(new Error(ev.data.error)); };
  }
  const id = ++seq;
  return new Promise((res, rej) => { waiting.set(id, { res, rej }); worker!.postMessage({ ...msg, id }, transfer); });
}

/** Zones available on this device (stored) and loaded in the routing thread. */
export const device = {
  loaded: new Set<string>(),
  /** per loaded zone: does its road map include expressways (flagged)? older downloads left them out */
  expressways: new Map<string, boolean>(),
  get withExpressways() { return [...this.loaded].every((z) => this.expressways.get(z)); },
  /** bounding boxes of loaded zones, for quick synchronous "is this point covered?" checks */
  boxes: new Map<string, [number, number, number, number]>(),
  coversSync(p: LngLat) { for (const b of this.boxes.values()) if (p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]) return true; return false; },
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },

  async installed(): Promise<{ zone: string; bytes: number; at: number; generated?: string }[]> {
    return (await db.graphs.toArray()).map(({ zone, bytes, at, generated }) => ({ zone, bytes, at, generated }));
  },

  /** Load every stored zone into the routing thread (at app start). */
  async boot() {
    for (const g of await db.graphs.toArray()) {
      try { const r = await call({ type: 'load', zone: g.zone, buf: await g.blob.arrayBuffer() }); this.loaded.add(g.zone); this.boxes.set(g.zone, r.bbox); this.expressways.set(g.zone, !!r.hasBanned); } catch { /* corrupt → ignore */ }
    }
    this.emit();
  },

  /** Download a zone (gzip) from the app's own site, unpack, store, load. */
  async download(zone: string, onProgress?: (done: number, total: number) => void) {
    const res = await fetch(`${import.meta.env.BASE_URL}graphs/${zone}.rgg.gz`, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`This region isn't available yet (${res.status})`);
    const total = +(res.headers.get('content-length') ?? 0);
    let done = 0;
    const counted = res.body.pipeThrough(new TransformStream({ transform(chunk, c) { done += chunk.byteLength; onProgress?.(done, total); c.enqueue(chunk); } }));
    // some servers already decode .gz (Content-Encoding: gzip) — only unpack if it's still gzip (1f 8b)
    const got = await new Response(counted).arrayBuffer();
    const head = new Uint8Array(got, 0, 2);
    const raw = head[0] === 0x1f && head[1] === 0x8b
      ? await new Response(new Blob([got]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
      : got;
    const meta = await fetch(`${import.meta.env.BASE_URL}graphs/${zone}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    await db.graphs.put({ zone, blob: new Blob([raw]), bytes: raw.byteLength, at: Date.now(), generated: meta?.generated });
    const r = await call({ type: 'load', zone, buf: raw }, [raw]);
    this.loaded.add(zone); this.boxes.set(zone, r.bbox); this.expressways.set(zone, !!r.hasBanned);
    // one detail level per region: drop the other tier of the same region
    const other = zone.endsWith('-main') ? zone.slice(0, -5) : `${zone}-main`;
    if (this.loaded.has(other) || (await db.graphs.get(other))) await this.remove(other);
    this.emit();
  },

  async remove(zone: string) {
    await db.graphs.delete(zone);
    await call({ type: 'unload', zone });
    this.loaded.delete(zone); this.boxes.delete(zone); this.expressways.delete(zone);
    this.emit();
  },

  /** One leg that never comes within gapM of the given lines (flat [x0,y0,x1,y1,…]); null if impossible. */
  async routeAvoiding(from: LngLat, to: LngLat, segs: number[], gapM: number, goalSegs?: number[]): Promise<LegResult | null> {
    if (!this.loaded.size) return null;
    const r = await call<{ result: { coords: LngLat[]; distM: number; names: (string | undefined)[] } | null }>({ type: 'avoid', from, to, segs, gapM, goalSegs });
    const leg = r.result;
    if (!leg) return null;
    const turns: Turn[] = deriveTurns(leg.coords).map((t) => ({ ...t, n: leg.names[Math.min(leg.names.length - 1, t.i + 1)] }));
    return { coords: leg.coords, distM: leg.distM, turns };
  },

  /** The road at a point (within maxM): name, posted limit, optionally its geometry. */
  async roadAt(p: LngLat, maxM = 40, geom = false): Promise<{ name: string; limit: number | null; d: number; coords?: LngLat[] } | null> {
    if (!this.loaded.size) return null;
    return (await call<{ result: any }>({ type: 'roadAt', p, maxM, geom })).result;
  },

  async covers(points: LngLat[]): Promise<boolean> {
    if (!this.loaded.size) return false;
    const r = await call<{ result: boolean[] }>({ type: 'covers', points });
    return r.result.every(Boolean);
  },

  async route(points: LngLat[]): Promise<(LegResult | null)[]> {
    // daily rides may use expressways (unless the rider avoids them); the expedition never does
    const r = await call<{ result: ({ coords: LngLat[]; distM: number; names: (string | undefined)[]; lanes?: (string | undefined)[] } | null)[] }>({ type: 'route', points, allowBanned: !avoidingBanned() && !routing.dailyOpts?.()?.avoidMotorway, avoidSegs: routing.avoidSegs?.(), shortest: !!routing.dailyOpts?.()?.shortest, longDistance: !!routing.dailyOpts?.() });
    return r.result.map((leg) => {
      if (!leg) return null;
      // turn instructions from the geometry; each turn is named after the road it turns onto
      const turns: Turn[] = deriveTurns(leg.coords).map((t) => ({ ...t, n: leg.names[Math.min(leg.names.length - 1, t.i + 1)], l: lanesForTurn(leg.lanes?.[t.i], t.c) }));
      return { coords: leg.coords, distM: leg.distM, turns };
    });
  },
};

/** Provider wrapper so the routing queue can use the device router like any server. */
export const deviceProvider: Provider & { canRoute(points: LngLat[]): Promise<boolean> } = {
  id: 'device', label: 'On-device router', maxWaypoints: 200, minIntervalMs: 0,
  canRoute: (points) => device.covers(points),
  async route(points) {
    const legs = await device.route(points);
    if (legs.some((l) => !l)) throw Object.assign(new Error('Some points are outside the downloaded regions'), { offline: true });
    return legs as LegResult[];
  },
  async nearest(p) {
    if (!device.loaded.size) return null;
    const r = await call<{ result: LngLat | null }>({ type: 'snap', p });
    return r.result;
  },
};
