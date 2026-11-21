import { getSetting, putSetting } from '../core/db';
import type { Hit, SearchOpts, LngLat } from './poiIndex';

/** Offline search + road-alert data per zone: downloaded once, stored on the device, searched in a worker. */
let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
function call<T>(msg: object): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => { const p = pending.get(ev.data.id); if (!p) return; pending.delete(ev.data.id); if (ev.data.ok) p.res(ev.data); else p.rej(new Error(ev.data.error)); };
  }
  const id = ++seq;
  return new Promise<T>((res, rej) => { pending.set(id, { res, rej }); worker!.postMessage({ ...msg, id }); });
}
async function dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle('poi', { create: true }); }
async function writeText(name: string, text: string) { const w = await ((await (await dir()).getFileHandle(name, { create: true })) as any).createWritable(); await w.write(text); await w.close(); }

export interface PoiZone { zone: string; generated?: string; poi: number; at: number }
/** Road alerts (speed cameras, bumps, rail crossings, tolls, signals…) for §3, per zone: lon, lat, kind, maxspeed. */
export const alertData = new Map<string, Float64Array & { kinds?: string[]; speeds?: string[] }>();

export const offlineSearch = {
  listeners: new Set<() => void>(),
  ready: false,
  loaded: new Set<string>(),
  emit() { this.listeners.forEach((f) => f()); },
  async installed(): Promise<PoiZone[]> { return getSetting<PoiZone[]>('poiZones', []); },

  async boot() {
    if (!navigator.storage?.getDirectory) return;
    for (const z of await this.installed()) { try { await this.load(z.zone); } catch { /* missing */ } }
    this.ready = true; this.emit();
  },
  async load(zone: string) {
    const r = await call<{ xy: Float64Array; kinds: string[]; speeds: string[] }>({ type: 'addFile', zone });
    this.loaded.add(zone);
    const a = r.xy as Float64Array & { kinds?: string[]; speeds?: string[] };
    a.kinds = r.kinds; a.speeds = r.speeds;
    alertData.set(zone, a);
  },
  async download(zone: string, base = `${import.meta.env.BASE_URL}poi`) {
    const [poi, alerts, meta] = await Promise.all([
      fetch(`${base}/${zone}.poi.tsv`).then((r) => { if (!r.ok) throw new Error(`Search data isn't available yet (${r.status})`); return r.text(); }),
      fetch(`${base}/${zone}.alerts.tsv`).then((r) => (r.ok ? r.text() : '')),
      fetch(`${base}/${zone}.poi.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    await writeText(`${zone}.poi.tsv`, poi); await writeText(`${zone}.alerts.tsv`, alerts);
    await call({ type: 'reset' }); this.loaded.clear();
    const list = (await this.installed()).filter((z) => z.zone !== zone);
    list.push({ zone, generated: meta?.generated, poi: meta?.poi ?? 0, at: Date.now() });
    await putSetting('poiZones', list);
    for (const z of list) await this.load(z.zone);
    this.emit();
  },
  async remove(zone: string) {
    try { const d = await dir(); await d.removeEntry(`${zone}.poi.tsv`); await d.removeEntry(`${zone}.alerts.tsv`); } catch { /* gone */ }
    const list = (await this.installed()).filter((z) => z.zone !== zone);
    await putSetting('poiZones', list); alertData.delete(zone);
    await call({ type: 'reset' }); this.loaded.clear();
    for (const z of list) await this.load(z.zone);
    this.emit();
  },
  async search(q: string, opts: SearchOpts): Promise<Hit[]> { if (!this.loaded.size) return []; return (await call<{ result: Hit[] }>({ type: 'search', q, opts })).result; },
  async nearby(near: LngLat): Promise<{ cat: string; label: string; hits: Hit[] }[]> { if (!this.loaded.size) return []; return (await call<{ result: any }>({ type: 'nearby', near })).result; },
};


// ---------- search history (per device convenience)
const HK = 'ridegrid.daily.history';
export interface HistItem { name: string; address: string; p: LngLat; at: number }
export function history(): HistItem[] { try { return JSON.parse(localStorage.getItem(HK) ?? '[]'); } catch { return []; } }
export function remember(h: Omit<HistItem, 'at'>) {
  try { localStorage.setItem(HK, JSON.stringify([{ ...h, at: Date.now() }, ...history().filter((x) => x.name !== h.name || x.p[0] !== h.p[0])].slice(0, 30))); } catch { /* private mode */ }
}
export function clearHistory() { try { localStorage.removeItem(HK); } catch { /* ignore */ } }
