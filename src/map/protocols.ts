import * as maplibregl from 'maplibre-gl';

/**
 * Remembers every custom tile protocol RideGrid gives the map engine (offline map tiles, contour lines,
 * offline rasters…), so the Google map can load the very same tiles when it draws our layers.
 * Register protocols through `addProtocol` here (not maplibregl.addProtocol directly).
 */
type Handler = (params: { url: string; type?: string }, abort: AbortController) => Promise<{ data: any }>;
const registry = new Map<string, Handler>();
export function addProtocol(name: string, h: Handler | any) { registry.set(name, h); maplibregl.addProtocol(name, h); }
/** For libraries that register their own protocols (maplibre-contour). */
export const protocolHost = { addProtocol };

const cache = new Map<string, Promise<ArrayBuffer | null>>();
/** Bytes of a tile URL — custom protocol or plain https — cached (last ~400 tiles). */
export function fetchTileBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    const scheme = url.split('://')[0];
    const h = registry.get(scheme);
    if (h) {
      const ac = new AbortController();
      signal?.addEventListener('abort', () => ac.abort());
      const r = await h({ url, type: 'arrayBuffer' }, ac);
      const d = r?.data;
      if (!d) return null;
      if (d instanceof ArrayBuffer) return d;
      if (ArrayBuffer.isView(d)) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
      if (d instanceof Blob) return d.arrayBuffer();
      return null;
    }
    const r = await fetch(url, { signal });
    return r.ok ? r.arrayBuffer() : null;
  })().catch(() => { cache.delete(url); return null; });
  cache.set(url, p);
  if (cache.size > 400) cache.delete(cache.keys().next().value!);
  return p;
}
