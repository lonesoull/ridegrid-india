import { protocolHost } from '../map/protocols';
import type { Map as MLMap, StyleSpecification } from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { getSetting, putSetting } from '../core/db';
import { dailyStyle, type DailyStyle } from './offlineMap';
import { offlineTerrain } from './offlineTerrain';
/** Offline terrain is stored to zoom 10; online tiles go to 13. */
const offlineTerrainMax = () => (offlineTerrain.zones.length && !navigator.onLine ? 10 : 13);

/**
 * Daily ride map settings + overlays (OsmAnd "Configure map"):
 * base style, hillshade, contour lines, 3D terrain, rain radar, satellite, Wikipedia places, street photos.
 */
export interface DailyMapSettings {
  style: DailyStyle | 'google';
  hillshade: boolean; contours: boolean; terrain3d: boolean;
  rain: boolean; satellite: boolean; wiki: boolean; photos: boolean;
  autoNight: boolean;
  /** switch day/night map by sunrise & sunset */ autoDayNight: boolean;
  grid: boolean; regions: boolean; rings: boolean;
  orientation: 'heading' | 'north' | 'compass';
  /** colour the land by altitude (OsmAnd terrain colour scheme) */ altitudeColours: boolean;
  /** 3D terrain exaggeration */ exaggeration: number;
  /** extra raster maps (OsmAnd online/raster maps plugin): overlay above / underlay below the vector map */
  overlay: string | null; overlayOpacity: number; underlay: string | null;
  customSources: { id: string; name: string; url: string; maxzoom: number }[];
  /** weather map layers (OsmAnd weather plugin) */
  wxTemp: boolean; wxWind: boolean; wxCloud: boolean; wxPressure: boolean;
  voyage: boolean;
  /** Google base map (online): map type, Google's transit / cycling layers, label language */
  gType: 'roadmap' | 'satellite' | 'hybrid' | 'terrain'; gTransit: boolean; gBike: boolean; labelLang: string;
  /** OpenStreetMap tracks, paths and unpaved roads drawn over Google (Google hides most of them) */
  trails: boolean;
  /** offline map: fewer / more labels and small roads (OsmAnd "map details") */
  detail: 'low' | 'normal' | 'high';
}
export const DEFAULT_DAILY_MAP: DailyMapSettings = { style: 'day', hillshade: false, contours: false, terrain3d: false, rain: false, satellite: false, wiki: false, photos: false, autoNight: true, autoDayNight: false, grid: false, regions: false, rings: false, orientation: 'heading',
  altitudeColours: false, exaggeration: 1.3, overlay: null, overlayOpacity: 0.6, underlay: null, customSources: [], wxTemp: false, wxWind: false, wxCloud: false, wxPressure: false, voyage: false,
  gType: 'roadmap', gTransit: false, gBike: false, labelLang: 'en', trails: true, detail: 'normal' };

export const dailyMap = {
  settings: { ...DEFAULT_DAILY_MAP },
  listeners: new Set<() => void>(),
  async load() { this.settings = { ...DEFAULT_DAILY_MAP, ...(await getSetting('dailyMap', DEFAULT_DAILY_MAP)) }; },
  async save(p: Partial<DailyMapSettings>) { this.settings = { ...this.settings, ...p }; await putSetting('dailyMap', this.settings); this.listeners.forEach((f) => f()); },
};

/** Built-in raster maps (all free, attribution shown). */
export const RASTER_PRESETS: { id: string; name: string; url: string; maxzoom: number; attribution: string }[] = [
  { id: 'opentopo', name: 'OpenTopoMap (contours & hills)', url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', maxzoom: 17, attribution: '© OpenTopoMap (CC-BY-SA)' },
  { id: 'cyclosm', name: 'CyclOSM (tracks & surfaces)', url: 'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', maxzoom: 18, attribution: '© CyclOSM, OpenStreetMap' },
  { id: 'osm', name: 'OpenStreetMap standard', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxzoom: 19, attribution: '© OpenStreetMap contributors' },
  { id: 'esri-sat', name: 'Satellite (Esri)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxzoom: 19, attribution: 'Imagery © Esri' },
  { id: 'esri-topo', name: 'Topographic (Esri)', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', maxzoom: 19, attribution: '© Esri' },
  { id: 'opnv', name: 'Public transport (ÖPNV)', url: 'https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png', maxzoom: 17, attribution: '© memomaps.de, OpenStreetMap' },
];
export const rasterSource = (id: string | null) => (id ? RASTER_PRESETS.find((r) => r.id === id) ?? dailyMap.settings.customSources.find((r) => r.id === id) : undefined);

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
let dem: InstanceType<typeof mlcontour.DemSource> | null = null;
function demSource() {
  if (!dem) {
    // main-thread fetches, so downloaded offline terrain can answer them (see offlineTerrain.ts)
    dem = new mlcontour.DemSource({ url: DEM_URL, encoding: 'terrarium', maxzoom: offlineTerrainMax(), worker: false });
    dem.setupMaplibre(protocolHost as any);
  }
  return dem;
}

/** Full style for the chosen Daily base map, with overlays inserted below the app's own layers. */
/**
 * onGoogle = the Google map is the base: build only our layers on a see-through style, and leave out
 * whatever Google does itself (satellite, hill shading, 3D, street photos; contours on Google terrain).
 */
export async function buildDailyStyle(night: boolean, onGoogle = false): Promise<StyleSpecification> {
  const s = dailyMap.settings;
  const base: DailyStyle = s.style === 'google' ? 'day' : night && s.autoNight && (s.style === 'day' || s.style === 'bright' || s.style === 'light') ? 'night' : s.style;
  const style: StyleSpecification = onGoogle
    ? { version: 8, glyphs: 'rgasset://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sources: {}, layers: [] }
    : await dailyStyle(base);
  if (onGoogle) { const { installMapProtocols } = await import('./offlineMap'); installMapProtocols(); }
  const topo = !onGoogle && base === 'topo';
  // first label layer: overlays go under the labels
  const firstLabel = style.layers.findIndex((l) => l.type === 'symbol');
  const at = firstLabel < 0 ? style.layers.length : firstLabel;
  const extra: StyleSpecification['layers'] = [];
  if (s.satellite && !onGoogle) {
    style.sources.sat = { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' };
    extra.push({ id: 'd-sat', type: 'raster', source: 'sat', paint: { 'raster-opacity': 0.9 } });
  }
  const ov = rasterSource(s.overlay), un = rasterSource(s.underlay);
  if (ov) {
    style.sources.overlay = { type: 'raster', tiles: [`rgraster://${ov.url.replace(/^https:\/\//, '')}`], tileSize: 256, maxzoom: ov.maxzoom, attribution: (ov as any).attribution ?? ov.name };
    extra.push({ id: 'd-overlay', type: 'raster', source: 'overlay', paint: { 'raster-opacity': s.overlayOpacity } });
  }
  if (un && !onGoogle) {
    style.sources.underlay = { type: 'raster', tiles: [`rgraster://${un.url.replace(/^https:\/\//, '')}`], tileSize: 256, maxzoom: un.maxzoom, attribution: (un as any).attribution ?? un.name };
    // under everything; the vector map's land / background become see-through
    for (const l of style.layers) if (l.type === 'background' || (l.type === 'fill' && /land|park|wood|grass|residential|landuse/.test(l.id))) (l as any).paint = { ...(l as any).paint, [l.type === 'background' ? 'background-opacity' : 'fill-opacity']: 0.15 };
    style.layers.splice(1, 0, { id: 'd-underlay', type: 'raster', source: 'underlay' });
  }
  const gTerrain = onGoogle && s.gType === 'terrain';
  const wantHill = (s.hillshade || topo) && !gTerrain, wantContours = (s.contours || topo) && !gTerrain, want3d = s.terrain3d && !onGoogle;
  if (wantHill || wantContours || want3d || s.altitudeColours) {
    const d = demSource();
    style.sources.dem = { type: 'raster-dem', tiles: [d.sharedDemProtocolUrl], encoding: 'terrarium', tileSize: 256, maxzoom: 13, attribution: 'Terrain: Mapzen / AWS Terrain Tiles' };
    if (s.altitudeColours) extra.push({ id: 'd-altitude', type: 'color-relief' as any, source: 'dem', paint: { 'color-relief-opacity': 0.45,
      'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#5aa36b', 200, '#9fcf7a', 500, '#e9e39a', 1000, '#d9b26a', 2000, '#b07a4a', 3500, '#9a8f8a', 5000, '#ffffff'] } } as any);
    if (wantHill) extra.push({ id: 'd-hillshade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': night ? '#000' : '#5a4a3a' } });
    if (wantContours) {
      style.sources.contours = {
        type: 'vector', maxzoom: 15,
        tiles: [d.contourProtocolUrl({ thresholds: { 11: [100, 500], 12: [50, 250], 13: [20, 100], 14: [10, 50] }, elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours' })],
      };
      extra.push({ id: 'd-contour', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: 11, paint: { 'line-color': night ? '#c9a77a' : '#a06b2d', 'line-opacity': 0.55, 'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5] } });
      style.layers.push({ id: 'd-contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 12, filter: ['>', ['get', 'level'], 0],
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'], 'text-size': 10, 'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': night ? '#e6d2b0' : '#7a4f1d', 'text-halo-color': night ? '#000' : '#fff', 'text-halo-width': 1 } });
    }
    if (want3d) style.terrain = { source: 'dem', exaggeration: s.exaggeration };
  }
  if (s.rain) {
    const host = await rainHost();
    if (host) {
      style.sources.rain = { type: 'raster', tiles: [`${host}/256/{z}/{x}/{y}/4/1_1.png`], tileSize: 256, maxzoom: 7, attribution: 'Rain radar © RainViewer' };
      extra.push({ id: 'd-rain', type: 'raster', source: 'rain', paint: { 'raster-opacity': 0.6 } });
    }
  }
  if (onGoogle && s.trails) {
    // OSM tracks / paths / unpaved roads (same vector tiles as the offline map), drawn over Google
    style.sources.osm = { type: 'vector', tiles: ['rgmap://{z}/{x}/{y}'], minzoom: 0, maxzoom: 14, attribution: '© OpenStreetMap contributors' };
    extra.push({ id: 'd-trails', type: 'line', source: 'osm', 'source-layer': 'transportation', minzoom: 11,
      filter: ['any', ['in', ['get', 'class'], ['literal', ['track', 'path']]], ['in', ['get', 'surface'], ['literal', ['unpaved', 'gravel', 'dirt', 'ground', 'sand']]]],
      paint: { 'line-color': night ? '#e0a96d' : '#9c5b1c', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 3], 'line-dasharray': [2, 1.5], 'line-opacity': 0.9 } });
  }
  if (s.photos && !onGoogle) {
    style.sources.panoramax = { type: 'vector', tiles: ['https://api.panoramax.xyz/api/map/{z}/{x}/{y}.mvt'], minzoom: 0, maxzoom: 15, attribution: 'Street photos © Panoramax contributors' };
    extra.push({ id: 'd-photo-seq', type: 'line', source: 'panoramax', 'source-layer': 'sequences', paint: { 'line-color': '#0a8f5a', 'line-width': 2, 'line-opacity': 0.8 } });
  }
  if (onGoogle) style.layers.unshift(...extra); else style.layers.splice(at, 0, ...extra);
  if (!onGoogle) applyDetail(style, s.detail ?? 'normal');
  scaleText(style, textScale());
  return style;
}

let rainUrl: Promise<string | null> | null = null;
async function rainHost() {
  rainUrl ??= fetch('https://api.rainviewer.com/public/weather-maps.json').then((r) => r.json())
    .then((j) => { const f = j?.radar?.nowcast?.[0] ?? j?.radar?.past?.at(-1); return f ? `${j.host}${f.path}` : null; }).catch(() => null);
  const u = await rainUrl;
  setTimeout(() => { rainUrl = null; }, 10 * 60000); // radar frames refresh every 10 min
  return u;
}

/** Wikipedia articles near a point (OsmAnd's Wikipedia layer), as GeoJSON. */
export async function wikiNear(map: MLMap, site = 'en.wikipedia.org'): Promise<GeoJSON.FeatureCollection> {
  const c = map.getCenter();
  const url = `https://${site}/w/api.php?action=query&list=geosearch&gscoord=${c.lat.toFixed(5)}|${c.lng.toFixed(5)}&gsradius=10000&gslimit=100&format=json&origin=*`;
  const j = navigator.onLine ? await fetch(url).then((r) => r.json()).catch(() => null) : null;
  if (!j?.query?.geosearch) {
    // no signal: articles saved for this area
    const { wikiOffline } = await import('./wikiOffline');
    const b = map.getBounds();
    const off = await wikiOffline.near([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], site);
    return { type: 'FeatureCollection', features: off.map((g) => ({ type: 'Feature', properties: { title: g.t, id: g.id, site }, geometry: { type: 'Point', coordinates: [g.x, g.y] } })) };
  }
  return { type: 'FeatureCollection', features: (j?.query?.geosearch ?? []).map((g: any) => ({ type: 'Feature', properties: { title: g.title, id: g.pageid, site }, geometry: { type: 'Point', coordinates: [g.lon, g.lat] } })) };
}

/** Ground elevation (m) at points, from the terrain tiles (zoom 11, ~60 m pixels). */
export async function elevations(pts: [number, number][]): Promise<number[]> {
  const d = demSource(), z = 11, n = 2 ** z;
  const tiles = new Map<string, Promise<{ width: number; height: number; data: Float32Array } | null>>();
  return Promise.all(pts.map(async ([lng, lat]) => {
    const x = ((lng + 180) / 360) * n;
    const yr = (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2 * n;
    const tx = Math.floor(x), ty = Math.floor(yr), k = `${tx}/${ty}`;
    if (!tiles.has(k)) tiles.set(k, d.getDemTile(z, tx, ty).catch(() => null));
    const t = await tiles.get(k);
    if (!t) return NaN;
    const px = Math.min(t.width - 1, Math.floor((x - tx) * t.width)), py = Math.min(t.height - 1, Math.floor((yr - ty) * t.height));
    return t.data[py * t.width + px];
  }));
}

/** Rider's label size for RideGrid's own map text (Google's labels follow the phone's settings). */
function textScale(): number { try { return JSON.parse(localStorage.getItem('ridegrid.daily.textScale') ?? '1') || 1; } catch { return 1; } }
function scaleSize(v: any, k: number): any {
  if (typeof v === 'number') return +(v * k).toFixed(2);
  if (Array.isArray(v) && (v[0] === 'interpolate' || v[0] === 'interpolate-hcl')) return v.map((x, i) => (i > 3 && i % 2 === 1 ? scaleSize(x, k) : x));
  if (Array.isArray(v) && v[0] === 'step') return v.map((x, i) => (i === 2 || (i > 2 && i % 2 === 0) ? scaleSize(x, k) : x));
  if (Array.isArray(v)) return ['*', k, v];
  if (v && typeof v === 'object' && Array.isArray(v.stops)) return { ...v, stops: v.stops.map(([z, x]: [number, number]) => [z, x * k]) };
  return v;
}
function scaleText(style: StyleSpecification, k: number) {
  if (Math.abs(k - 1) < 0.01) return;
  for (const l of style.layers as any[]) if (l.layout?.['text-size'] !== undefined) l.layout['text-size'] = scaleSize(l.layout['text-size'], k);
    else if (l.type === 'symbol' && l.layout?.['text-field']) l.layout = { ...l.layout, 'text-size': 16 * k };
}

/** Offline-map detail: "low" shows labels and minor roads one zoom later, "high" one zoom earlier. Our own layers (d-*, rg-*) are left alone. */
function applyDetail(style: StyleSpecification, d: 'low' | 'normal' | 'high') {
  if (d === 'normal') return;
  const k = d === 'low' ? 1 : -1;
  for (const l of style.layers as any[]) {
    if (/^(d-|rg-)/.test(l.id) || l.type === 'background') continue;
    const minor = l.type === 'symbol' || /minor|service|path|track|poi|building/.test(l.id);
    if (!minor) continue;
    l.minzoom = Math.max(0, (l.minzoom ?? 0) + k);
  }
}
