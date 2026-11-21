import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import { onMapSettled } from '../map/googleJs';
import type { MapController } from '../map/MapController';
import { mode } from '../core/mode';
import { dailyMap } from './mapLayers';

/**
 * Weather on the map (OsmAnd weather plugin): temperature, wind arrows, cloud cover and pressure on a
 * grid over the visible area, from Open-Meteo (free, no key; one request per refresh).
 */
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
let last = '';

async function gridData(m: MLMap): Promise<GeoJSON.FeatureCollection> {
  const b = m.getBounds(), N = 7;
  const lats: number[] = [], lngs: number[] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    lats.push(+(b.getSouth() + ((i + 0.5) / N) * (b.getNorth() - b.getSouth())).toFixed(3));
    lngs.push(+(b.getWest() + ((j + 0.5) / N) * (b.getEast() - b.getWest())).toFixed(3));
  }
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lngs.join(',')}&current=temperature_2m,wind_speed_10m,wind_direction_10m,cloud_cover,pressure_msl`;
  const j = await fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const arr = Array.isArray(j) ? j : j ? [j] : [];
  return { type: 'FeatureCollection', features: arr.map((x: any, i: number) => ({ type: 'Feature', properties: {
    t: Math.round(x.current?.temperature_2m), w: Math.round(x.current?.wind_speed_10m), wd: x.current?.wind_direction_10m, c: x.current?.cloud_cover, p: Math.round(x.current?.pressure_msl),
  }, geometry: { type: 'Point', coordinates: [lngs[i], lats[i]] } })) };
}

export function startWeatherLayers(ctl: MapController) {
  const on = () => mode.current === 'daily' && (dailyMap.settings.wxTemp || dailyMap.settings.wxWind || dailyMap.settings.wxCloud || dailyMap.settings.wxPressure);
  const vis = (id: string, v: boolean) => { if (ctl.map.getLayer(id)) ctl.map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none'); };
  const apply = () => {
    const s = dailyMap.settings, d = mode.current === 'daily';
    vis('d-wx-cloud', d && s.wxCloud); vis('d-wx-temp', d && s.wxTemp); vis('d-wx-temp-l', d && s.wxTemp); vis('d-wx-wind', d && s.wxWind); vis('d-wx-p', d && s.wxPressure);
  };
  ctl.styleHooks.add((m) => {
    if (m.getSource('d-wx')) return;
    m.addSource('d-wx', { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'd-wx-cloud', type: 'circle', source: 'd-wx', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 40, 10, 120], 'circle-blur': 1, 'circle-color': '#7a8aa0', 'circle-opacity': ['/', ['coalesce', ['get', 'c'], 0], 180] } });
    m.addLayer({ id: 'd-wx-temp', type: 'circle', source: 'd-wx', paint: { 'circle-radius': 16, 'circle-opacity': 0.75,
      'circle-color': ['interpolate', ['linear'], ['coalesce', ['get', 't'], 25], 0, '#3b5bdb', 15, '#4dabf7', 25, '#ffd43b', 32, '#ff922b', 40, '#e03131'] } });
    m.addLayer({ id: 'd-wx-temp-l', type: 'symbol', source: 'd-wx', layout: { 'text-field': ['concat', ['to-string', ['get', 't']], '°'], 'text-size': 12, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-color': '#111' } });
    m.addLayer({ id: 'd-wx-wind', type: 'symbol', source: 'd-wx', layout: { 'text-field': ['concat', '➤ ', ['to-string', ['get', 'w']]], 'text-size': 13, 'text-offset': [0, 1.6], 'text-rotate': ['+', ['coalesce', ['get', 'wd'], 0], 90], 'text-rotation-alignment': 'map', 'text-allow-overlap': true, 'text-font': ['Noto Sans Bold'] }, paint: { 'text-color': '#0b7285', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
    m.addLayer({ id: 'd-wx-p', type: 'symbol', source: 'd-wx', layout: { 'text-field': ['concat', ['to-string', ['get', 'p']], ' hPa'], 'text-size': 10, 'text-offset': [0, -1.8], 'text-allow-overlap': true, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#5f3dc4', 'text-halo-color': '#fff', 'text-halo-width': 1 } });
    apply();
    void refresh();
  });
  const refresh = async () => {
    apply();
    if (!on()) return;
    const m = ctl.map, b = m.getBounds();
    const key = `${b.getWest().toFixed(1)},${b.getSouth().toFixed(1)},${b.getEast().toFixed(1)},${b.getNorth().toFixed(1)},${Math.floor(Date.now() / 900000)}`;
    if (key === last) return;
    last = key;
    (m.getSource('d-wx') as GeoJSONSource | undefined)?.setData(await gridData(m));
  };
  onMapSettled(ctl.map, () => void refresh());
  dailyMap.listeners.add(() => { last = ''; void refresh(); });
}
