import { PMTiles, type Source, type RangeResponse } from 'pmtiles';
import { getSetting, putSetting } from '../core/db';
import { canNativeFetch, nativeDownload, nativeJson, RELEASES } from './nativeFetch';

/**
 * Offline terrain (OsmAnd terrain / contour-line downloads): elevation tiles per region stored on the
 * device. Every terrain request (hillshade, contours, 3D, altitude colours, elevation profile) is answered
 * from these files when they cover the tile, else from the internet.
 */
export const DEM_PREFIX = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/';
class FileSrc implements Source {
  constructor(private f: File, private k: string) {}
  getKey() { return this.k; }
  async getBytes(o: number, l: number): Promise<RangeResponse> { return { data: await this.f.slice(o, o + l).arrayBuffer() }; }
}
const dir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('terrain', { create: true });
const dems = new Map<string, { pm: PMTiles; b: number[]; maxZoom: number }>();
export interface DemZone { zone: string; bytes: number; generated?: string }

export const offlineTerrain = {
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  installed: () => getSetting<DemZone[]>('demZones', []),
  async boot() {
    if (!navigator.storage?.getDirectory) return;
    for (const z of await this.installed()) { try { await this.open(z.zone); } catch { /* missing */ } }
    patchFetch();
    this.emit();
  },
  async open(zone: string) {
    const f = await (await (await dir()).getFileHandle(`${zone}.dem.pmtiles`)).getFile();
    const pm = new PMTiles(new FileSrc(f, `dem:${zone}`));
    const h = await pm.getHeader();
    dems.set(zone, { pm, b: [h.minLon, h.minLat, h.maxLon, h.maxLat], maxZoom: h.maxZoom });
  },
  async meta(zone: string): Promise<DemZone | null> {
    if (canNativeFetch()) return nativeJson(`${RELEASES}/india-terrain/${zone}.dem.json`);
    return fetch(`${import.meta.env.BASE_URL}terrain/${zone}.dem.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  },
  async download(zone: string, onProgress?: (d: number, t: number) => void) {
    if (!canNativeFetch()) throw new Error('Offline terrain downloads work in the RideGrid Android / laptop app');
    const m = await this.meta(zone);
    if (!m) throw new Error("This region's terrain isn't available yet");
    const d = await dir();
    const fh = await d.getFileHandle(`${zone}.dem.pmtiles`, { create: true });
    const w = await (fh as any).createWritable();
    try { await nativeDownload(`${RELEASES}/india-terrain/${zone}.dem.pmtiles`, m.bytes, (c) => w.write(c), 0, onProgress); await w.close(); }
    catch (e) { await w.abort?.(); throw e; }
    await this.open(zone);
    await putSetting('demZones', [...(await this.installed()).filter((x) => x.zone !== zone), { zone, bytes: m.bytes, generated: m.generated }]);
    this.emit();
  },
  async remove(zone: string) {
    dems.delete(zone);
    try { await (await dir()).removeEntry(`${zone}.dem.pmtiles`); } catch { /* gone */ }
    await putSetting('demZones', (await this.installed()).filter((x) => x.zone !== zone));
    this.emit();
  },
  get zones() { return [...dems.keys()]; },
};

const t2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const t2lat = (y: number, z: number) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };

let patched = false;
/** Answer terrain-tile requests from the downloaded regions (falls back to the internet). */
function patchFetch() {
  if (patched) return;
  patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(DEM_PREFIX) && dems.size) {
      const m = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
      if (m) {
        let z = +m[1], x = +m[2], y = +m[3];
        const cx = t2lon(x + 0.5, z), cy = t2lat(y + 0.5, z);
        for (const d of dems.values()) {
          if (cx < d.b[0] || cx > d.b[2] || cy < d.b[1] || cy > d.b[3]) continue;
          if (z > d.maxZoom) continue; // deeper zooms: the map over-zooms the max-zoom tile
          const t = await d.pm.getZxy(z, x, y);
          if (t?.data) return new Response(t.data, { status: 200, headers: { 'Content-Type': 'image/png' } });
        }
        if (!navigator.onLine) return new Response(null, { status: 404 });
      }
    }
    return orig(input as any, init);
  };
}
