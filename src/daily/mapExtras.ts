import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl';
import type { MapController } from '../map/MapController';
import { mode } from '../core/mode';
import { nav } from '../nav/navigator';
import { ui } from '../ui/state';
import { dailyMap } from './mapLayers';
import { offlineMaps } from './offlineMap';
import { device } from '../route/device';
import { offlineSearch } from './offlineSearch';
import { sunTimes } from './sun';
import type { LngLat } from '../core/geo';
import { google } from '../core/google';
import { placeAt } from './gfeatures';

/**
 * Daily map extras (OsmAnd): tap any place for its card, automatic day/night, north-up / compass
 * orientation, coordinate grid, downloaded-region outlines, radius rings.
 */
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const daily = () => mode.current === 'daily';

export function startMapExtras(ctl: MapController) {
  const m = ctl.map;
  // ---- tap a place on the base map → place card (enriched from the offline index: hours, phone)
  ctl.tapHooks.push((e, box) => {
    if (!daily()) return false;
    const f = m.queryRenderedFeatures(box).find((x) => x.layer.type === 'symbol' && x.properties?.name && !String(x.layer.id).startsWith('rg-') && !String(x.layer.id).startsWith('d-')
      && /poi|place|peak|aerodrome|transport|station|water_name|park/.test(String(x.sourceLayer ?? x.layer.id)));
    if (!f) return false;
    const pr = f.properties as any;
    const name = pr['name:en'] || pr['name:latin'] || pr.name;
    const p: LngLat = f.geometry.type === 'Point' ? (f.geometry.coordinates as LngLat) : [e.lngLat.lng, e.lngLat.lat];
    const kind = [pr.subclass, pr.class].filter((x: string, i: number, a: string[]) => x && a.indexOf(x) === i).join(' · ').replace(/_/g, ' ');
    ui.set({ place: { id: `map:${p}`, name, address: kind || String(f.sourceLayer ?? ''), p, provider: 'osm' }, selectedId: null });
    void offlineSearch.search(name, { near: p, limit: 1 }).then(([h]) => {
      if (!h || Math.hypot((h.p[0] - p[0]) * 111000, (h.p[1] - p[1]) * 111000) > 200) return;
      const [hours, phone, brand, city] = h.info.split('|');
      const cur = ui.get().place;
      if (cur?.id === `map:${p}`) ui.set({ place: { ...cur, address: [h.label, hours && `🕒 ${hours}`, phone && `☎ ${phone}`, brand, city].filter(Boolean).join(' · ') } });
    }).catch(() => {});
    return true;
  });

  // ---- Google base: long-press (or tap in view-only mode) → Google place / address card
  const googlePlace = (lng: number, lat: number) => void placeAt([lng, lat]).then((g) => {
    if (!g) return;
    ui.set({ place: { id: g.id ? `g:${g.id}` : `addr:${lng},${lat}`, name: g.name, address: [g.type, g.address].filter(Boolean).join(' · '), p: g.p, provider: 'google' }, selectedId: null });
  }).catch(() => {});
  m.on('contextmenu', (e) => { if (daily() && google.tilesOk) googlePlace(e.lngLat.lng, e.lngLat.lat); });
  ctl.tapHooks.push((e) => {
    if (!daily() || !google.tilesOk || ui.get().tapMode !== 'off') return false;
    googlePlace(e.lngLat.lng, e.lngLat.lat);
    return true;
  });

  // ---- automatic day / night by sunrise & sunset
  const dayNight = () => {
    if (!daily() || !dailyMap.settings.autoDayNight) return;
    const c = nav.pos ?? [m.getCenter().lng, m.getCenter().lat];
    const s = sunTimes(new Date(), c[1], c[0]);
    if (!s.riseAt || !s.setAt) return;
    const night = Date.now() < s.riseAt.getTime() || Date.now() > s.setAt.getTime();
    if (ui.get().night !== night) ui.set({ night });
  };
  setInterval(dayNight, 60000); setTimeout(dayNight, 3000);
  dailyMap.listeners.add(dayNight);

  // ---- orientation: direction of travel / north up / compass
  let compass: number | null = null;
  const onOri = (ev: DeviceOrientationEvent) => {
    const a = (ev as any).webkitCompassHeading ?? (ev.absolute && ev.alpha !== null ? 360 - ev.alpha : null);
    if (a !== null && a !== undefined) compass = a;
  };
  window.addEventListener('deviceorientationabsolute' as any, onOri);
  window.addEventListener('deviceorientation', onOri);
  ctl.followBearing = (h) => {
    if (!daily()) return null;
    const o = dailyMap.settings.orientation;
    if (o === 'north') return 0;
    if (o === 'compass') return nav.speedMps < 2 && compass !== null ? compass : h;
    return null;
  };

  // ---- grid, region outlines, radius rings
  const data = () => ({
    grid: daily() && dailyMap.settings.grid ? grid(m) : EMPTY,
    regions: daily() && dailyMap.settings.regions ? regions() : EMPTY,
    rings: daily() && dailyMap.settings.rings ? rings(m) : EMPTY,
  });
  ctl.styleHooks.add((mm) => {
    if (mm.getSource('d-extras-grid')) return;
    const d = data();
    mm.addSource('d-extras-grid', { type: 'geojson', data: d.grid });
    mm.addLayer({ id: 'd-grid-line', type: 'line', source: 'd-extras-grid', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#888', 'line-width': 0.8, 'line-dasharray': [3, 3] } });
    mm.addLayer({ id: 'd-grid-label', type: 'symbol', source: 'd-extras-grid', filter: ['==', '$type', 'Point'], layout: { 'text-field': ['get', 't'], 'text-size': 10, 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#555', 'text-halo-color': '#fff', 'text-halo-width': 1 } });
    mm.addSource('d-extras-regions', { type: 'geojson', data: d.regions });
    mm.addLayer({ id: 'd-regions', type: 'line', source: 'd-extras-regions', paint: { 'line-color': ['get', 'c'], 'line-width': 2, 'line-opacity': 0.8 } });
    mm.addSource('d-extras-rings', { type: 'geojson', data: d.rings });
    mm.addLayer({ id: 'd-rings', type: 'line', source: 'd-extras-rings', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#0a84ff', 'line-width': 1.2, 'line-opacity': 0.7 } });
    mm.addLayer({ id: 'd-rings-label', type: 'symbol', source: 'd-extras-rings', filter: ['==', '$type', 'Point'], layout: { 'text-field': ['get', 't'], 'text-size': 11, 'text-font': ['Noto Sans Bold'] }, paint: { 'text-color': '#0a84ff', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
  });
  const refresh = () => {
    const d = data();
    (m.getSource('d-extras-grid') as GeoJSONSource | undefined)?.setData(d.grid);
    (m.getSource('d-extras-regions') as GeoJSONSource | undefined)?.setData(d.regions);
    (m.getSource('d-extras-rings') as GeoJSONSource | undefined)?.setData(d.rings);
  };
  m.on('moveend', refresh);
  dailyMap.listeners.add(refresh);
  offlineMaps.listeners.add(refresh);
  nav.subscribe(() => { if (daily() && dailyMap.settings.rings) refresh(); });
}

function grid(m: MLMap): GeoJSON.FeatureCollection {
  const b = m.getBounds(), z = m.getZoom();
  const step = z < 5 ? 10 : z < 7 ? 5 : z < 8 ? 2 : z < 9 ? 1 : z < 11 ? 0.5 : z < 12 ? 0.2 : z < 13 ? 0.1 : z < 14 ? 0.05 : 0.02;
  const f: GeoJSON.Feature[] = [];
  const dec = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  for (let x = Math.ceil(b.getWest() / step) * step; x <= b.getEast(); x += step) {
    f.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[x, b.getSouth()], [x, b.getNorth()]] } });
    f.push({ type: 'Feature', properties: { t: `${x.toFixed(dec)}°E` }, geometry: { type: 'Point', coordinates: [x, b.getNorth() - (b.getNorth() - b.getSouth()) * 0.03] } });
  }
  for (let y = Math.ceil(b.getSouth() / step) * step; y <= b.getNorth(); y += step) {
    f.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[b.getWest(), y], [b.getEast(), y]] } });
    f.push({ type: 'Feature', properties: { t: `${y.toFixed(dec)}°N` }, geometry: { type: 'Point', coordinates: [b.getWest() + (b.getEast() - b.getWest()) * 0.06, y] } });
  }
  return { type: 'FeatureCollection', features: f };
}

function regions(): GeoJSON.FeatureCollection {
  const box = (bb: number[], c: string, name: string): GeoJSON.Feature => ({ type: 'Feature', properties: { c, name },
    geometry: { type: 'LineString', coordinates: [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]] } });
  const f: GeoJSON.Feature[] = [];
  for (const [z, b] of device.boxes) f.push(box(b, '#2e7d32', `Routing: ${z}`));
  for (const [z, b] of offlineMaps.bounds()) f.push(box(b, '#1565c0', `Map: ${z}`));
  return { type: 'FeatureCollection', features: f };
}

function rings(m: MLMap): GeoJSON.FeatureCollection {
  const c: LngLat = nav.pos ?? [m.getCenter().lng, m.getCenter().lat];
  const z = m.getZoom();
  const radii = z > 15 ? [100, 250, 500] : z > 13 ? [500, 1000, 2000] : z > 11 ? [1000, 2000, 5000] : z > 9 ? [5000, 10000, 20000] : [20000, 50000, 100000];
  const f: GeoJSON.Feature[] = [];
  const kx = 111320 * Math.cos((c[1] * Math.PI) / 180), ky = 110540;
  for (const r of radii) {
    const pts: LngLat[] = [];
    for (let i = 0; i <= 64; i++) { const a = (i / 64) * 2 * Math.PI; pts.push([c[0] + (Math.sin(a) * r) / kx, c[1] + (Math.cos(a) * r) / ky]); }
    f.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: pts } });
    f.push({ type: 'Feature', properties: { t: r >= 1000 ? `${r / 1000} km` : `${r} m` }, geometry: { type: 'Point', coordinates: [c[0], c[1] + r / ky] } });
  }
  return { type: 'FeatureCollection', features: f };
}

/** Moon phase (0 = new, 0.5 = full) and its name — for the moon widget. */
export function moonPhase(d = new Date()) {
  const synodic = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14) / 86400000;
  const p = (((d.getTime() / 86400000 - ref) / synodic) % 1 + 1) % 1;
  const names = ['🌑 New moon', '🌒 Waxing crescent', '🌓 First quarter', '🌔 Waxing gibbous', '🌕 Full moon', '🌖 Waning gibbous', '🌗 Last quarter', '🌘 Waning crescent'];
  return { phase: p, name: names[Math.round(p * 8) % 8], illum: Math.round(((1 - Math.cos(2 * Math.PI * p)) / 2) * 100) };
}
