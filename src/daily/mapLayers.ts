import * as maplibregl from 'maplibre-gl';
import type { Map as MLMap, StyleSpecification } from 'maplibre-gl';
import mlcontour from 'maplibre-contour';
import { getSetting, putSetting } from '../core/db';
import { dailyStyle, type DailyStyle } from './offlineMap';

/**
 * Daily ride map settings + overlays (OsmAnd "Configure map"):
 * base style, hillshade, contour lines, 3D terrain, rain radar, satellite, Wikipedia places, street photos.
 */
export interface DailyMapSettings {
  style: DailyStyle | 'google';
  hillshade: boolean; contours: boolean; terrain3d: boolean;
  rain: boolean; satellite: boolean; wiki: boolean; photos: boolean;
  autoNight: boolean;
}
export const DEFAULT_DAILY_MAP: DailyMapSettings = { style: 'day', hillshade: false, contours: false, terrain3d: false, rain: false, satellite: false, wiki: false, photos: false, autoNight: true };

export const dailyMap = {
  settings: { ...DEFAULT_DAILY_MAP },
  listeners: new Set<() => void>(),
  async load() { this.settings = { ...DEFAULT_DAILY_MAP, ...(await getSetting('dailyMap', DEFAULT_DAILY_MAP)) }; },
  async save(p: Partial<DailyMapSettings>) { this.settings = { ...this.settings, ...p }; await putSetting('dailyMap', this.settings); this.listeners.forEach((f) => f()); },
};

const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
let dem: InstanceType<typeof mlcontour.DemSource> | null = null;
function demSource() {
  if (!dem) {
    dem = new mlcontour.DemSource({ url: DEM_URL, encoding: 'terrarium', maxzoom: 13, worker: true });
    dem.setupMaplibre(maplibregl as any);
  }
  return dem;
}

/** Full style for the chosen Daily base map, with overlays inserted below the app's own layers. */
export async function buildDailyStyle(night: boolean): Promise<StyleSpecification> {
  const s = dailyMap.settings;
  const base: DailyStyle = s.style === 'google' ? 'day' : night && s.autoNight && (s.style === 'day' || s.style === 'bright' || s.style === 'light') ? 'night' : s.style;
  const style = await dailyStyle(base);
  const topo = base === 'topo';
  // first label layer: overlays go under the labels
  const firstLabel = style.layers.findIndex((l) => l.type === 'symbol');
  const at = firstLabel < 0 ? style.layers.length : firstLabel;
  const extra: StyleSpecification['layers'] = [];
  if (s.satellite) {
    style.sources.sat = { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' };
    extra.push({ id: 'd-sat', type: 'raster', source: 'sat', paint: { 'raster-opacity': 0.9 } });
  }
  if (s.hillshade || s.contours || s.terrain3d || topo) {
    const d = demSource();
    style.sources.dem = { type: 'raster-dem', tiles: [d.sharedDemProtocolUrl], encoding: 'terrarium', tileSize: 256, maxzoom: 13, attribution: 'Terrain: Mapzen / AWS Terrain Tiles' };
    if (s.hillshade || topo) extra.push({ id: 'd-hillshade', type: 'hillshade', source: 'dem', paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': night ? '#000' : '#5a4a3a' } });
    if (s.contours || topo) {
      style.sources.contours = {
        type: 'vector', maxzoom: 15,
        tiles: [d.contourProtocolUrl({ thresholds: { 11: [100, 500], 12: [50, 250], 13: [20, 100], 14: [10, 50] }, elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours' })],
      };
      extra.push({ id: 'd-contour', type: 'line', source: 'contours', 'source-layer': 'contours', minzoom: 11, paint: { 'line-color': night ? '#c9a77a' : '#a06b2d', 'line-opacity': 0.55, 'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5] } });
      style.layers.push({ id: 'd-contour-label', type: 'symbol', source: 'contours', 'source-layer': 'contours', minzoom: 12, filter: ['>', ['get', 'level'], 0],
        layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'], 'text-size': 10, 'text-font': ['Noto Sans Regular'] },
        paint: { 'text-color': night ? '#e6d2b0' : '#7a4f1d', 'text-halo-color': night ? '#000' : '#fff', 'text-halo-width': 1 } });
    }
    if (s.terrain3d) style.terrain = { source: 'dem', exaggeration: 1.3 };
  }
  if (s.rain) {
    const host = await rainHost();
    if (host) {
      style.sources.rain = { type: 'raster', tiles: [`${host}/256/{z}/{x}/{y}/4/1_1.png`], tileSize: 256, maxzoom: 7, attribution: 'Rain radar © RainViewer' };
      extra.push({ id: 'd-rain', type: 'raster', source: 'rain', paint: { 'raster-opacity': 0.6 } });
    }
  }
  if (s.photos) {
    style.sources.panoramax = { type: 'vector', tiles: ['https://api.panoramax.xyz/api/map/{z}/{x}/{y}.mvt'], minzoom: 0, maxzoom: 15, attribution: 'Street photos © Panoramax contributors' };
    extra.push({ id: 'd-photo-seq', type: 'line', source: 'panoramax', 'source-layer': 'sequences', paint: { 'line-color': '#0a8f5a', 'line-width': 2, 'line-opacity': 0.8 } });
  }
  style.layers.splice(at, 0, ...extra);
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
export async function wikiNear(map: MLMap): Promise<GeoJSON.FeatureCollection> {
  const c = map.getCenter();
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${c.lat.toFixed(5)}|${c.lng.toFixed(5)}&gsradius=10000&gslimit=100&format=json&origin=*`;
  const j = await fetch(url).then((r) => r.json()).catch(() => null);
  return { type: 'FeatureCollection', features: (j?.query?.geosearch ?? []).map((g: any) => ({ type: 'Feature', properties: { title: g.title, id: g.pageid }, geometry: { type: 'Point', coordinates: [g.lon, g.lat] } })) };
}
