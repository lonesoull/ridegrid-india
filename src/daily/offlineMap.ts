import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification, RequestParameters } from 'maplibre-gl';
import { PMTiles, type Source, type RangeResponse } from 'pmtiles';
import { getSetting, putSetting } from '../core/db';
import { canNativeFetch, nativeDownload, nativeJson, RELEASES } from './nativeFetch';

/**
 * Daily-mode map engine (OsmAnd-style offline maps).
 *
 * One vector source `rgmap://{z}/{x}/{y}` serves every tile:
 *   1. from a downloaded region file (PMTiles, OpenMapTiles schema) stored on this device, or
 *   2. online from OpenFreeMap (same schema) when no downloaded region covers the tile.
 * Style JSON, sprites and fonts are cached the first time they load, so the map keeps working offline.
 */
export const ONLINE_STYLE = {
  day: 'https://tiles.openfreemap.org/styles/liberty',
  bright: 'https://tiles.openfreemap.org/styles/bright',
  light: 'https://tiles.openfreemap.org/styles/positron',
  night: 'https://tiles.openfreemap.org/styles/dark',
  fiord: 'https://tiles.openfreemap.org/styles/fiord',
};
const ASSET_CACHE = 'ridegrid-map-assets-v1';
export const RASTER_CACHE = 'ridegrid-raster-tiles-v1';

// ---------------------------------------------------------------- region files (OPFS)
export interface MapZone { zone: string; bytes: number; generated?: string; at: number }

/** A PMTiles source reading a file stored in the browser's private file system. */
class OpfsSource implements Source {
  constructor(private file: File, private key: string) {}
  getKey() { return this.key; }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    return { data: await this.file.slice(offset, offset + length).arrayBuffer() };
  }
}

async function dir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('maps', { create: true });
}

const archives = new Map<string, { pm: PMTiles; bounds: [number, number, number, number]; maxZoom: number }>();

export const offlineMaps = {
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  get zones() { return [...archives.keys()]; },
  async installed(): Promise<MapZone[]> { return getSetting<MapZone[]>('mapZones', []); },

  /** Open every downloaded region at app start. */
  async boot() {
    if (!('storage' in navigator) || !navigator.storage.getDirectory) return;
    for (const z of await this.installed()) {
      try { await this.open(z.zone); } catch { /* missing / corrupt → ignore */ }
    }
    this.emit();
  },

  async open(zone: string) {
    const fh = await (await dir()).getFileHandle(`${zone}.pmtiles`);
    const file = await fh.getFile();
    const pm = new PMTiles(new OpfsSource(file, zone));
    const h = await pm.getHeader();
    archives.set(zone, { pm, bounds: [h.minLon, h.minLat, h.maxLon, h.maxLat], maxZoom: h.maxZoom });
  },

  /** Size + date of a region's map file (from the app's GitHub releases in the apps, else the map server). */
  async meta(zone: string, server: string): Promise<{ bytes: number; generated?: string } | null> {
    if (canNativeFetch()) return nativeJson(`${RELEASES}/india-tiles/${zone}.tiles.json`);
    return fetch(`${server}/${zone}.tiles.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  },

  /** Download a region file straight to device storage (hundreds of MB — never held in memory). */
  async download(zone: string, server: string, onProgress?: (done: number, total: number) => void) {
    if (!navigator.storage?.getDirectory) throw new Error('This browser cannot store offline maps');
    void navigator.storage.persist?.();
    const meta = await this.meta(zone, server);
    if (!meta) throw new Error("This region's map isn't available yet");
    const d = await dir();
    const tmp = await d.getFileHandle(`${zone}.part`, { create: true });
    // resume a partial download (same file version only)
    const partOf = (await getSetting<string | null>(`mapPart.${zone}`, null));
    const have = partOf === meta.generated ? (await tmp.getFile()).size : 0;
    const w = await (tmp as any).createWritable({ keepExistingData: have > 0 });
    if (have) await w.seek(have);
    await putSetting(`mapPart.${zone}`, meta.generated ?? '');
    let done = have;
    try {
      if (canNativeFetch()) {
        done = await nativeDownload(`${RELEASES}/india-tiles/${zone}.pmtiles`, meta.bytes, (c) => w.write(c), have, onProgress);
      } else {
        const res = await fetch(`${server}/${zone}.pmtiles`, { cache: 'no-store', headers: have ? { Range: `bytes=${have}-` } : {} });
        if (!res.ok || !res.body) throw new Error(`This map isn't available yet (${res.status})`);
        if (have && res.status !== 206) { await w.truncate(0); done = 0; }
        const reader = res.body.getReader();
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          await w.write(value);
          done += value.byteLength;
          onProgress?.(done, meta.bytes);
        }
      }
      await w.close();
    } catch (e) { try { await w.close(); } catch { /* keep the partial file for resuming */ } throw e; }
    if (meta.bytes && done < meta.bytes) throw new Error('Download incomplete — tap Download again to resume');
    // swap in the new file
    archives.delete(zone);
    try { await d.removeEntry(`${zone}.pmtiles`); } catch { /* first download */ }
    try { if ((tmp as any).move) await (tmp as any).move(`${zone}.pmtiles`); } catch { /* fall back to copying */ }
    if (!(await d.getFileHandle(`${zone}.pmtiles`).then(() => true, () => false))) {
      const fw = await ((await d.getFileHandle(`${zone}.pmtiles`, { create: true })) as any).createWritable();
      await (await tmp.getFile()).stream().pipeTo(fw);
      await d.removeEntry(`${zone}.part`);
    }
    await putSetting(`mapPart.${zone}`, null);
    await this.open(zone);
    const list = (await this.installed()).filter((z) => z.zone !== zone);
    list.push({ zone, bytes: done, generated: meta.generated, at: Date.now() });
    await putSetting('mapZones', list);
    this.emit();
  },

  async remove(zone: string) {
    archives.delete(zone);
    try { await (await dir()).removeEntry(`${zone}.pmtiles`); } catch { /* already gone */ }
    await putSetting('mapZones', (await this.installed()).filter((z) => z.zone !== zone));
    this.emit();
  },

  /** Bounding boxes of downloaded map regions. */
  bounds(): [string, number[]][] { return [...archives.entries()].map(([z, a]) => [z, a.bounds]); },

  /** Does a downloaded region cover this point? */
  covers(lng: number, lat: number) {
    for (const a of archives.values()) if (lng >= a.bounds[0] && lng <= a.bounds[2] && lat >= a.bounds[1] && lat <= a.bounds[3]) return true;
    return false;
  },
};

// ---------------------------------------------------------------- tile + asset protocols
const tile2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tile2lat = (y: number, z: number) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

let onlineTemplate: Promise<string | null> | null = null;
function onlineTiles() {
  onlineTemplate ??= cachedJson('https://tiles.openfreemap.org/planet').then((j) => j?.tiles?.[0] ?? null).catch(() => null);
  return onlineTemplate;
}

async function cachedFetch(url: string): Promise<Response> {
  const cache = await caches.open(ASSET_CACHE);
  const hit = await cache.match(url);
  if (hit) {
    // refresh in the background when online
    if (navigator.onLine) void fetch(url).then((r) => { if (r.ok) void cache.put(url, r); }).catch(() => {});
    return hit;
  }
  const r = await fetch(url);
  if (r.ok) await cache.put(url, r.clone());
  return r;
}
async function cachedJson(url: string) { return (await cachedFetch(url)).json(); }

let installed = false;
export function installMapProtocols() {
  if (installed) return;
  installed = true;
  maplibregl.addProtocol('rgmap', async (params: RequestParameters) => {
    const m = /rgmap:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    if (!m) throw new Error('bad tile url');
    const z = +m[1], x = +m[2], y = +m[3];
    const cx = tile2lon(x + 0.5, z), cy = tile2lat(y + 0.5, z);
    for (const a of archives.values()) {
      if (z > a.maxZoom) continue;
      if (cx < a.bounds[0] || cx > a.bounds[2] || cy < a.bounds[1] || cy > a.bounds[3]) continue;
      const t = await a.pm.getZxy(z, x, y);
      if (t?.data) return { data: new Uint8Array(t.data) };
    }
    if (!navigator.onLine) return { data: new Uint8Array() }; // nothing downloaded here → empty tile
    const tpl = await onlineTiles();
    if (!tpl) return { data: new Uint8Array() };
    const r = await fetch(tpl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
    return { data: r.ok ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array() };
  });
  // extra raster maps: cache-first, so areas saved for offline (or viewed before) work without internet
  maplibregl.addProtocol('rgraster', async (params: RequestParameters) => {
    const url = params.url.replace(/^rgraster:\/\//, 'https://');
    const cache = await caches.open(RASTER_CACHE);
    const hit = await cache.match(url);
    if (hit) return { data: await hit.arrayBuffer() };
    if (!navigator.onLine) return { data: new ArrayBuffer(0) };
    const r = await fetch(url);
    if (!r.ok) return { data: new ArrayBuffer(0) };
    void cache.put(url, r.clone());
    return { data: await r.arrayBuffer() };
  });
  // fonts and sprites: cache-first so labels and icons survive offline
  maplibregl.addProtocol('rgasset', async (params: RequestParameters) => {
    const url = params.url.replace(/^rgasset:\/\//, 'https://');
    const r = await cachedFetch(url);
    if (!r.ok) throw new Error(`asset ${r.status}`);
    return { data: params.type === 'json' ? await r.json() : await r.arrayBuffer() };
  });
}

// ---------------------------------------------------------------- styles
export type DailyStyle = 'day' | 'night' | 'bright' | 'light' | 'fiord' | 'touring' | 'topo' | 'offroad' | 'desert';
export const STYLE_LABEL: Record<DailyStyle, string> = {
  day: 'Standard', night: 'Night', bright: 'Bright', light: 'Light', fiord: 'Fiord (blue night)',
  touring: 'Touring (high contrast)', topo: 'Topo (terrain & contours)', offroad: 'Off-road (tracks & trails)', desert: 'Desert',
};

const base = (s: DailyStyle): keyof typeof ONLINE_STYLE => (s in ONLINE_STYLE ? (s as keyof typeof ONLINE_STYLE) : s === 'touring' ? 'bright' : 'day');

/** Build the full MapLibre style for a Daily-mode map style (offline-capable). */
export async function dailyStyle(s: DailyStyle): Promise<StyleSpecification> {
  installMapProtocols();
  const style = structuredClone(await cachedJson(ONLINE_STYLE[base(s)])) as StyleSpecification;
  for (const [id, src] of Object.entries(style.sources)) {
    if (src.type === 'vector') style.sources[id] = { type: 'vector', tiles: ['rgmap://{z}/{x}/{y}'], minzoom: 0, maxzoom: 14, attribution: '© OpenMapTiles © OpenStreetMap contributors' };
  }
  if (typeof style.glyphs === 'string') style.glyphs = style.glyphs.replace(/^https:\/\//, 'rgasset://');
  if (typeof style.sprite === 'string') style.sprite = style.sprite.replace(/^https:\/\//, 'rgasset://');
  // Indian place names: prefer English / Latin (MapLibre can't shape Indic scripts correctly yet)
  for (const l of style.layers) {
    if (l.type === 'symbol' && l.layout?.['text-field']) (l.layout as any)['text-field'] = ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']];
  }
  restyle(style, s);
  return style;
}

/** Paint tweaks that turn the base styles into Touring / Topo / Off-road / Desert. */
function restyle(style: StyleSpecification, s: DailyStyle) {
  const set = (match: (id: string) => boolean, prop: string, v: unknown) => {
    for (const l of style.layers) if (match(l.id) && l.type !== 'symbol') (l as any).paint = { ...(l as any).paint, [prop]: v };
  };
  const isRoad = (id: string) => /road|highway|bridge|tunnel/.test(id) && !/label|shield|name/.test(id);
  if (s === 'touring') {
    set((id) => isRoad(id) && /motorway|trunk|primary/.test(id) && !/casing/.test(id), 'line-color', '#f06d2b');
    set((id) => isRoad(id) && /secondary|tertiary/.test(id) && !/casing/.test(id), 'line-color', '#f7c948');
    set((id) => isRoad(id) && /casing/.test(id), 'line-color', '#3a2a1a');
  } else if (s === 'offroad') {
    set((id) => /track|path|service|minor/.test(id) && isRoad(id) && !/casing/.test(id), 'line-color', '#b4561e');
    set((id) => /track|path/.test(id) && isRoad(id), 'line-width', ['interpolate', ['linear'], ['zoom'], 10, 1.2, 16, 4]);
  } else if (s === 'desert') {
    set((id) => id === 'background', 'background-color', '#efe2c4');
    set((id) => /landcover|landuse|park|wood|grass/.test(id), 'fill-color', '#e4d1a6');
  } else if (s === 'topo') {
    set((id) => /wood|forest/.test(id), 'fill-color', '#b9d9a6');
  }
}

/** Save a raster map for an area (OsmAnd "Download tiles"): every tile of bbox at zooms zmin..zmax. */
export async function saveRasterArea(urlTpl: string, bbox: [number, number, number, number], zmin: number, zmax: number, onProgress?: (done: number, total: number) => void) {
  const tiles: [number, number, number][] = [];
  const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat: number, z: number) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);
  for (let z = zmin; z <= zmax; z++) for (let x = lon2x(bbox[0], z); x <= lon2x(bbox[2], z); x++) for (let y = lat2y(bbox[3], z); y <= lat2y(bbox[1], z); y++) tiles.push([z, x, y]);
  if (tiles.length > 6000) throw new Error(`That is ${tiles.length} tiles — zoom in or lower the max zoom (limit 6000)`);
  const cache = await caches.open(RASTER_CACHE);
  let done = 0;
  const work = async () => {
    for (;;) {
      const t = tiles.pop(); if (!t) return;
      const u = urlTpl.replace('{z}', String(t[0])).replace('{x}', String(t[1])).replace('{y}', String(t[2]));
      if (!(await cache.match(u))) { const r = await fetch(u).catch(() => null); if (r?.ok) await cache.put(u, r); await new Promise((res) => setTimeout(res, 120)); }
      onProgress?.(++done, done + tiles.length);
    }
  };
  await Promise.all([work(), work(), work()]);
  return done;
}
