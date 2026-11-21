/**
 * Draws all of RideGrid's map layers ON the Google map (one map, one camera, one render):
 * reads the hidden map engine's style (layers, paint rules, GeoJSON data, tile sources) and renders
 * each layer with deck.gl inside Google's own WebGL frame, so nothing is stacked on top of Google.
 * Supports line / circle / symbol (text + icons) / fill on GeoJSON (with clustering), raster tiles
 * (rain radar, custom maps), vector tiles (contour lines, off-road trails) and hillshade from elevation tiles.
 */
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { PathLayer, ScatterplotLayer, TextLayer, IconLayer, SolidPolygonLayer, BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { PathStyleExtension, CollisionFilterExtension } from '@deck.gl/extensions';
import { parse } from '@loaders.gl/core';
import { MVTLoader } from '@loaders.gl/mvt';
import Supercluster from 'supercluster';
import { expression, featureFilter, latest } from '@maplibre/maplibre-gl-style-spec';
import type { Map as MLMap } from 'maplibre-gl';
import { fetchTileBytes } from './protocols';

type RGBA = [number, number, number, number];
type Geo = GeoJSON.Feature<GeoJSON.Geometry | null, any>;
type Eval = (zoom: number, f: any) => any;

// ---------------------------------------------------------------- style rule evaluation
const compiled = new Map<string, Eval>();
function rule(type: string, group: 'paint' | 'layout', name: string, raw: unknown): Eval {
  const spec = (latest as any)[`${group}_${type}`]?.[name];
  if (!spec) return () => undefined;
  const value = raw === undefined ? spec.default : raw;
  if (value === undefined) return () => undefined;
  const key = `${type}|${name}|${JSON.stringify(value)}`;
  let f = compiled.get(key);
  if (!f) {
    try { const e = (expression as any).normalizePropertyExpression(value, 'rg', spec); f = (zoom, feat) => e.evaluate({ zoom }, feat); }
    catch { f = () => undefined; }
    compiled.set(key, f);
  }
  return f;
}
const filters = new Map<string, (zoom: number, f: any) => boolean>();
function filterOf(filter: unknown): (zoom: number, f: any) => boolean {
  if (!filter) return () => true;
  const key = JSON.stringify(filter);
  let f = filters.get(key);
  if (!f) { try { const ff = (featureFilter as any)(filter, 'rg'); f = (zoom, feat) => ff.filter({ zoom }, feat); } catch { f = () => true; } filters.set(key, f); }
  return f;
}
/** style-spec Color (premultiplied 0–1) → deck RGBA 0–255, times an opacity */
function rgba(c: any, opacity = 1): RGBA {
  if (!c || typeof c.r !== 'number') return [0, 0, 0, 0];
  const a = c.a ?? 1;
  const un = (v: number) => Math.round((a > 0 ? v / a : 0) * 255);
  return [un(c.r), un(c.g), un(c.b), Math.round(Math.max(0, Math.min(1, a * opacity)) * 255)];
}
const gType = (g: GeoJSON.Geometry | null | undefined) => (!g ? 0 : g.type.endsWith('Point') ? 1 : g.type.endsWith('LineString') ? 2 : g.type.endsWith('Polygon') ? 3 : 0);
const evalFeature = (f: Geo) => ({ type: gType(f.geometry), properties: f.properties ?? {}, id: (f as any).id, geometry: f.geometry });
const textOf = (t: any): string => (t == null ? '' : typeof t === 'string' ? t : t.sections ? t.sections.map((s: any) => s.text).join('') : String(t));

// ---------------------------------------------------------------- geometry helpers
function flatten(data: any): Geo[] {
  if (!data) return [];
  if (data.type === 'FeatureCollection') return data.features;
  if (data.type === 'Feature') return [data];
  if (data.type) return [{ type: 'Feature', properties: {}, geometry: data }];
  return [];
}
function lines(g: GeoJSON.Geometry): number[][][] {
  switch (g.type) {
    case 'LineString': return [g.coordinates];
    case 'MultiLineString': return g.coordinates;
    case 'Polygon': return g.coordinates;
    case 'MultiPolygon': return g.coordinates.flat();
    default: return [];
  }
}
function points(g: GeoJSON.Geometry, placeOnLine: boolean): number[][] {
  switch (g.type) {
    case 'Point': return [g.coordinates];
    case 'MultiPoint': return g.coordinates;
    case 'LineString': case 'MultiLineString': {
      if (!placeOnLine) return [];
      return lines(g).filter((l) => l.length > 1).map((l) => l[Math.floor(l.length / 2)]);
    }
    default: return [];
  }
}
function polygons(g: GeoJSON.Geometry): number[][][][] {
  return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
}

// ---------------------------------------------------------------- icons from the map engine's images
const iconCache = new Map<string, { url: string; width: number; height: number; ratio: number } | null>();
function iconFor(ml: MLMap, name: string) {
  if (iconCache.has(name)) return iconCache.get(name)!;
  const img: any = (ml as any).getImage?.(name);
  if (!img?.data) { iconCache.set(name, null); return null; }
  const { width, height, data } = img.data;
  const c = document.createElement('canvas'); c.width = width; c.height = height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(data.buffer ? data : Uint8ClampedArray.from(data)), width, height), 0, 0);
  const v = { url: c.toDataURL(), width, height, ratio: img.pixelRatio ?? 1 };
  iconCache.set(name, v);
  return v;
}

// ---------------------------------------------------------------- layer builders (per style layer)
const DASH = new PathStyleExtension({ dash: true });
const COLLIDE = new CollisionFilterExtension();
const ANCHOR: Record<string, [string, string]> = {
  center: ['middle', 'center'], top: ['middle', 'top'], bottom: ['middle', 'bottom'], left: ['start', 'center'], right: ['end', 'center'],
  'top-left': ['start', 'top'], 'top-right': ['end', 'top'], 'bottom-left': ['start', 'bottom'], 'bottom-right': ['end', 'bottom'],
};

function buildLayers(ml: MLMap, L: any, feats: Geo[], zoom: number, idSuffix = ''): any[] {
  const id = `${L.id}${idSuffix}`;
  const t = L.type as string;
  const P = (n: string) => rule(t, 'paint', n, L.paint?.[n]);
  const Y = (n: string) => rule(t, 'layout', n, L.layout?.[n]);
  const keep = filterOf(L.filter);
  const list = feats.filter((f) => f.geometry && keep(zoom, evalFeature(f)));
  if (!list.length) return [];
  if (t === 'line') {
    const col = P('line-color'), op = P('line-opacity'), w = P('line-width'), dash = L.paint?.['line-dasharray'];
    const rows: any[] = [];
    for (const f of list) {
      const ef = evalFeature(f);
      const c = rgba(col(zoom, ef), op(zoom, ef) ?? 1), width = w(zoom, ef) ?? 1;
      for (const path of lines(f.geometry!)) if (path.length > 1) rows.push({ path, c, width });
    }
    const dashArr = Array.isArray(dash) && typeof dash[0] === 'number' ? dash as number[] : null;
    return [new PathLayer({
      id, data: rows, getPath: (d: any) => d.path, getColor: (d: any) => d.c, getWidth: (d: any) => d.width,
      widthUnits: 'pixels', capRounded: (L.layout?.['line-cap'] ?? 'butt') === 'round', jointRounded: (L.layout?.['line-join'] ?? 'miter') === 'round',
      ...(dashArr ? { extensions: [DASH], getDashArray: () => dashArr, dashJustified: true } : {}),
      parameters: { depthCompare: 'always' } as any,
    })];
  }
  if (t === 'circle') {
    const r = P('circle-radius'), col = P('circle-color'), op = P('circle-opacity'), sc = P('circle-stroke-color'), sw = P('circle-stroke-width'), so = P('circle-stroke-opacity');
    const rows: any[] = [];
    for (const f of list) {
      const ef = evalFeature(f);
      const s = sw(zoom, ef) ?? 0, rad = r(zoom, ef) ?? 5;
      for (const p of points(f.geometry!, false)) rows.push({ p, r: rad + s / 2, c: rgba(col(zoom, ef), op(zoom, ef) ?? 1), sc: rgba(sc(zoom, ef), so(zoom, ef) ?? 1), s });
    }
    return [new ScatterplotLayer({
      id, data: rows, getPosition: (d: any) => d.p, getRadius: (d: any) => d.r, radiusUnits: 'pixels', getFillColor: (d: any) => d.c,
      stroked: true, getLineColor: (d: any) => d.sc, getLineWidth: (d: any) => d.s, lineWidthUnits: 'pixels', parameters: { depthCompare: 'always' } as any,
    })];
  }
  if (t === 'fill') {
    const col = P('fill-color'), op = P('fill-opacity');
    const rows: any[] = [];
    for (const f of list) { const ef = evalFeature(f); const c = rgba(col(zoom, ef), op(zoom, ef) ?? 1); for (const poly of polygons(f.geometry!)) rows.push({ poly, c }); }
    return [new SolidPolygonLayer({ id, data: rows, getPolygon: (d: any) => d.poly, getFillColor: (d: any) => d.c, parameters: { depthCompare: 'always' } as any })];
  }
  if (t === 'symbol') {
    const out: any[] = [];
    const onLine = (L.layout?.['symbol-placement'] ?? 'point') !== 'point';
    const overlap = !!(L.layout?.['text-allow-overlap'] || L.layout?.['icon-allow-overlap']);
    // icons
    if (L.layout?.['icon-image'] !== undefined) {
      const img = Y('icon-image'), size = Y('icon-size'), rot = Y('icon-rotate'), op = P('icon-opacity');
      const mapAligned = L.layout?.['icon-rotation-alignment'] === 'map';
      const anchor = (L.layout?.['icon-anchor'] as string) ?? 'center';
      const rows: any[] = [];
      for (const f of list) {
        const ef = evalFeature(f);
        const nm = textOf(img(zoom, ef)?.name ?? img(zoom, ef));
        const ic = nm && iconFor(ml, nm);
        if (!ic) continue;
        const h = (ic.height / ic.ratio) * (size(zoom, ef) ?? 1);
        for (const p of points(f.geometry!, onLine)) rows.push({ p, ic: { id: nm, url: ic.url, width: ic.width, height: ic.height, anchorY: anchor.startsWith('bottom') ? ic.height : anchor.startsWith('top') ? 0 : ic.height / 2 }, h, a: -(rot(zoom, ef) ?? 0), o: Math.round((op(zoom, ef) ?? 1) * 255) });
      }
      if (rows.length) out.push(new IconLayer({
        id: `${id}-icon`, data: rows, getPosition: (d: any) => d.p, getIcon: (d: any) => d.ic, getSize: (d: any) => d.h, sizeUnits: 'pixels',
        getAngle: (d: any) => d.a, billboard: !mapAligned, getColor: (d: any) => [255, 255, 255, d.o], parameters: { depthCompare: 'always' } as any,
      }));
    }
    // text
    if (L.layout?.['text-field'] !== undefined) {
      const field = Y('text-field'), size = Y('text-size'), off = Y('text-offset'), anc = Y('text-anchor'), rot = Y('text-rotate');
      const col = P('text-color'), op = P('text-opacity'), halo = P('text-halo-color'), hw = P('text-halo-width');
      const font = JSON.stringify(L.layout?.['text-font'] ?? '');
      const rows: any[] = [];
      let haloC: RGBA = [0, 0, 0, 0], haloW = 0;
      for (const f of list) {
        const ef = evalFeature(f);
        const text = textOf(field(zoom, ef));
        if (!text) continue;
        const sz = size(zoom, ef) ?? 16, o = off(zoom, ef) ?? [0, 0], a = ANCHOR[anc(zoom, ef) ?? 'center'] ?? ANCHOR.center;
        if (!haloW) { haloW = hw(zoom, ef) ?? 0; haloC = rgba(halo(zoom, ef)); }
        for (const p of points(f.geometry!, onLine)) rows.push({ p, text, sz, off: [o[0] * sz, o[1] * sz], ta: a[0], ab: a[1], c: rgba(col(zoom, ef), op(zoom, ef) ?? 1), ang: -(rot(zoom, ef) ?? 0) });
      }
      if (rows.length) out.push(new TextLayer({
        id: `${id}-text`, data: rows, getPosition: (d: any) => d.p, getText: (d: any) => d.text, getSize: (d: any) => d.sz, sizeUnits: 'pixels',
        getColor: (d: any) => d.c, getPixelOffset: (d: any) => d.off, getTextAnchor: (d: any) => d.ta, getAlignmentBaseline: (d: any) => d.ab, getAngle: (d: any) => d.ang,
        characterSet: 'auto', fontFamily: 'Roboto, "Noto Sans", system-ui, sans-serif', fontWeight: /Bold/.test(font) ? 700 : 400,
        fontSettings: { sdf: true, buffer: 6 }, outlineWidth: haloW ? Math.min(4, haloW * 2) : 0, outlineColor: haloC,
        ...(overlap ? {} : { extensions: [COLLIDE], collisionGroup: id }), parameters: { depthCompare: 'always' } as any,
      }));
    }
    return out;
  }
  return [];
}

// ---------------------------------------------------------------- tiled sources
function template(src: any): string | null {
  const t = src?.tiles?.[0];
  return typeof t === 'string' ? t : null;
}
const fill = (u: string, x: number, y: number, z: number) => u.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{ratio}', '').replace('{r}', '');

function rasterLayer(L: any, src: any) {
  const url = template(src); if (!url) return null;
  const op = L.paint?.['raster-opacity'] ?? 1;
  return new TileLayer({
    id: L.id, minZoom: src.minzoom ?? 0, maxZoom: src.maxzoom ?? 18, tileSize: src.tileSize ?? 256,
    getTileData: async ({ index: { x, y, z }, signal }: any) => { const b = await fetchTileBytes(fill(url, x, y, z), signal); return b ? createImageBitmap(new Blob([b])) : null; },
    renderSubLayers: (p: any) => { const { west, south, east, north } = p.tile.bbox; return p.data ? new BitmapLayer({ ...p, data: undefined, image: p.data, bounds: [west, south, east, north], opacity: op }) : null; },
  });
}

/** Hillshade from terrarium elevation tiles (sun from the north-west, like the offline map). */
function hillshadeLayer(L: any, src: any) {
  const url = template(src); if (!url) return null;
  const ex = L.paint?.['hillshade-exaggeration'] ?? 0.5;
  return new TileLayer({
    id: L.id, minZoom: 0, maxZoom: src.maxzoom ?? 12, tileSize: src.tileSize ?? 256,
    getTileData: async ({ index: { x, y, z }, signal }: any) => {
      const b = await fetchTileBytes(fill(url, x, y, z), signal); if (!b) return null;
      const bmp = await createImageBitmap(new Blob([b]));
      const W = bmp.width, H = bmp.height, c = new OffscreenCanvas(W, H), g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0); const d = g.getImageData(0, 0, W, H); const px = d.data;
      const el = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) el[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      const mpp = (40075016.7 / 2 ** z / W) * Math.cos(Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z))));
      const k = (ex * 4) / mpp, out = g.createImageData(W, H);
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        const at = (a: number, b2: number) => el[Math.min(H - 1, Math.max(0, b2)) * W + Math.min(W - 1, Math.max(0, a))];
        const dx = (at(i + 1, j) - at(i - 1, j)) * k / 2, dy = (at(i, j + 1) - at(i, j - 1)) * k / 2;
        const shade = (-dx + dy) / Math.sqrt(1 + dx * dx + dy * dy); // light from NW
        const o = (j * W + i) * 4, v = shade > 0 ? 255 : 0, a = Math.min(160, Math.abs(shade) * 200);
        out.data[o] = out.data[o + 1] = out.data[o + 2] = v; out.data[o + 3] = a;
      }
      g.putImageData(out, 0, 0);
      return c.transferToImageBitmap();
    },
    renderSubLayers: (p: any) => { const { west, south, east, north } = p.tile.bbox; return p.data ? new BitmapLayer({ ...p, data: undefined, image: p.data, bounds: [west, south, east, north] }) : null; },
  });
}

/** Vector tiles (contour lines, trails): decoded to GeoJSON and drawn with the same layer rules. */
function vectorLayer(ml: MLMap, L: any, src: any) {
  const url = template(src); if (!url) return null;
  const srcLayer = L['source-layer'];
  return new TileLayer({
    id: L.id, minZoom: Math.max(src.minzoom ?? 0, Math.floor(L.minzoom ?? 0)), maxZoom: src.maxzoom ?? 14, tileSize: 512,
    getTileData: async ({ index: { x, y, z }, signal }: any) => {
      const b = await fetchTileBytes(fill(url, x, y, z), signal); if (!b) return null;
      const fc: any = await parse(b, MVTLoader, { worker: false, mvt: { coordinates: 'wgs84', tileIndex: { x, y, z }, layers: srcLayer ? [srcLayer] : undefined, shape: 'geojson' } } as any);
      return (Array.isArray(fc) ? fc : fc?.features ?? []) as Geo[];
    },
    renderSubLayers: (p: any) => (p.data?.length ? buildLayers(ml, L, p.data, p.tile.index.z, `-${p.tile.id}`) : null),
    updateTriggers: { renderSubLayers: [JSON.stringify(L.paint), JSON.stringify(L.layout), JSON.stringify(L.filter)] },
  });
}

/** stops / waypoints and their selection are Google's own pins instead */
const NATIVE = new Set(['rg-stop-pts', 'rg-stop-label', 'rg-clusters', 'rg-cluster-label', 'rg-sel']);

// ---------------------------------------------------------------- the bridge
export class GoogleBridge {
  private overlay: GoogleMapsOverlay;
  lastLayers: string[] = [];
  private raf = 0;
  private zoom = 0;
  private memo = new Map<string, { key: string; layers: any[] }>();
  private clusters = new Map<string, { data: any; index: Supercluster }>();
  private offs: (() => void)[] = [];
  constructor(gmap: any, private ml: MLMap) {
    // interleaved = drawn inside Google's own WebGL frame (vector map); on Google's basic raster map deck falls back to
    // an overlay that Google moves with the map. Accept software / low-end GPUs instead of failing.
    this.overlay = new GoogleMapsOverlay({ interleaved: true, layers: [], deviceProps: { webgl: { failIfMajorPerformanceCaveat: false, preserveDrawingBuffer: false } } } as any);
    // attach once Google has settled on its renderer (3D vector, or the basic raster fallback), and again if it switches
    const attach = () => { this.overlay.setMap(null); this.overlay.setMap(gmap); this.schedule(); };
    const g = (window as any).google.maps;
    if (gmap.getRenderingType?.() !== g.RenderingType?.UNINITIALIZED && gmap.getProjection?.()) attach();
    else g.event.addListenerOnce(gmap, 'idle', attach);
    const rl = gmap.addListener('renderingtype_changed', attach);
    this.offs.push(() => rl.remove());
    if (location.search.includes('rgdebug')) (window as any).__rgBridge = this;
    const kick = () => this.schedule();
    const onSrc = (e: any) => { if (e.dataType === 'source' && (e.sourceDataType === 'content' || e.sourceDataType === 'metadata' || e.sourceDataType === undefined)) kick(); };
    ml.on('styledata', kick); ml.on('sourcedata', onSrc);
    this.offs.push(() => { ml.off('styledata', kick); ml.off('sourcedata', onSrc); });
    // zoom-dependent sizes and clusters: rebuild when the zoom settles to a new quarter-step
    const zl = gmap.addListener('zoom_changed', () => { const z = Math.round(((gmap.getZoom() ?? 1) - 1) * 4) / 4; if (z !== this.zoom) { this.zoom = z; this.schedule(120); } });
    this.offs.push(() => zl.remove());
    this.zoom = Math.round(((gmap.getZoom() ?? 1) - 1) * 4) / 4;
    this.schedule();
  }
  private timer = 0;
  schedule(delay = 0) {
    if (delay) { clearTimeout(this.timer); this.timer = window.setTimeout(() => this.schedule(), delay); return; }
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; try { this.rebuild(); } catch (e) { console.warn('google bridge', e); } });
  }
  private dataOf(id: string): any {
    const s: any = this.ml.getSource(id);
    const d = s?._data;
    if (!d) return null;
    if (d.geojson) return d.geojson;
    if (d.updateable) return { type: 'FeatureCollection', features: [...d.updateable.values()] };
    if (d.url) { this.fetchUrl(id, d.url); return this.urls.get(d.url) ?? null; }
    return null;
  }
  private urls = new Map<string, any>();
  private fetchUrl(_id: string, url: string) {
    if (this.urls.has(url)) return;
    this.urls.set(url, null);
    void fetch(url).then((r) => r.json()).then((j) => { this.urls.set(url, j); this.schedule(); }).catch(() => {});
  }
  private clustered(id: string, src: any, data: any, zoom: number): Geo[] {
    let c = this.clusters.get(id);
    if (!c || c.data !== data) {
      const index = new Supercluster({ radius: src.clusterRadius ?? 50, maxZoom: src.clusterMaxZoom ?? 14, minPoints: src.clusterMinPoints ?? 2 });
      index.load(flatten(data).filter((f) => f.geometry?.type === 'Point') as any);
      c = { data, index }; this.clusters.set(id, c);
    }
    return c.index.getClusters([-180, -85, 180, 85], Math.floor(zoom)) as any;
  }
  private rebuild() {
    const style = this.ml.getStyle();
    if (!style) return;
    const zoom = this.zoom;
    const out: any[] = [];
    for (const L of style.layers as any[]) {
      if (L.type === 'background' || (L.layout?.visibility ?? 'visible') === 'none') continue;
      if (NATIVE.has(L.id)) continue; // drawn as Google's own pins (googleStops.ts)
      if ((L.minzoom !== undefined && zoom < L.minzoom - 0.5) || (L.maxzoom !== undefined && zoom >= L.maxzoom)) continue;
      const src: any = (style.sources as any)[L.source];
      if (!src) continue;
      if (src.type === 'geojson') {
        const data = this.dataOf(L.source);
        if (!data) continue;
        const key = `${zoom}|${JSON.stringify(L)}`;
        const m = this.memo.get(L.id);
        if (m && m.key === key && (m as any).data === data) { out.push(...m.layers); continue; }
        const feats = src.cluster ? this.clustered(L.source, src, data, zoom) : flatten(data);
        const layers = buildLayers(this.ml, L, feats, zoom);
        this.memo.set(L.id, Object.assign({ key, layers }, { data }));
        out.push(...layers);
      } else {
        const key = JSON.stringify([L, src.tiles]);
        const m = this.memo.get(L.id);
        if (m && m.key === key) { out.push(...m.layers); continue; }
        const l = src.type === 'raster' && L.type === 'raster' ? rasterLayer(L, src)
          : src.type === 'raster-dem' && L.type === 'hillshade' ? hillshadeLayer(L, src)
            : src.type === 'vector' ? vectorLayer(this.ml, L, src) : null;
        const layers = l ? [l] : [];
        this.memo.set(L.id, { key, layers });
        out.push(...layers);
      }
    }
    this.overlay.setProps({ layers: out });
    this.lastLayers = out.map((l) => l.id);
  }
  destroy() {
    cancelAnimationFrame(this.raf); clearTimeout(this.timer);
    this.offs.forEach((f) => f());
    this.overlay.setMap(null); this.overlay.finalize();
  }
}
