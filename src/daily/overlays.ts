import { Popup, type Map as MLMap, type GeoJSONSource } from 'maplibre-gl';
import type { MapController } from '../map/MapController';
import { mode } from '../core/mode';
import { dailyMap, wikiNear } from './mapLayers';
import { markers } from './markers';
import { quick } from './QuickActions';
import { ui } from '../ui/state';

/** Daily-mode overlays that are data, not tiles (Wikipedia places), refreshed as the map moves. */
export function startDailyOverlays(ctl: MapController) {
  let timer = 0;
  const refresh = (m: MLMap) => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const src = m.getSource('d-wiki') as GeoJSONSource | undefined;
      if (!src || m.getZoom() < 10) { src?.setData({ type: 'FeatureCollection', features: [] }); return; }
      const a = dailyMap.settings.wiki ? await wikiNear(m) : { type: 'FeatureCollection' as const, features: [] };
      const b = dailyMap.settings.voyage ? await wikiNear(m, 'en.wikivoyage.org') : { type: 'FeatureCollection' as const, features: [] };
      src.setData({ type: 'FeatureCollection', features: [...a.features, ...b.features] });
    }, 600);
  };
  ctl.styleHooks.add((m) => {
    if (mode.current !== 'daily' || !(dailyMap.settings.wiki || dailyMap.settings.voyage) || m.getSource('d-wiki')) return;
    m.addSource('d-wiki', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    m.addLayer({ id: 'd-wiki-dot', type: 'circle', source: 'd-wiki', paint: { 'circle-radius': 6, 'circle-color': ['match', ['get', 'site'], 'en.wikivoyage.org', '#2b8a3e', '#fff'], 'circle-stroke-color': '#333', 'circle-stroke-width': 2 } });
    m.addLayer({ id: 'd-wiki-label', type: 'symbol', source: 'd-wiki', minzoom: 12,
      layout: { 'text-field': ['get', 'title'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'], 'text-optional': true },
      paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    refresh(m);
  });
  // My places: favourites, markers, parked bike, notes
  const placesData = (): GeoJSON.FeatureCollection => (mode.current === 'daily' && !quick.hidePlaces ? markers.geojson() : { type: 'FeatureCollection', features: [] });
  ctl.styleHooks.add((m) => {
    if (m.getSource('d-places')) return;
    m.addSource('d-places', { type: 'geojson', data: placesData() });
    m.addLayer({ id: 'd-places-dot', type: 'circle', source: 'd-places', paint: { 'circle-radius': 11, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    m.addLayer({ id: 'd-places-icon', type: 'symbol', source: 'd-places', layout: { 'text-field': ['get', 'icon'], 'text-size': 12, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true }, paint: { 'text-color': '#fff' } });
    m.addLayer({ id: 'd-places-label', type: 'symbol', source: 'd-places', minzoom: 12, layout: { 'text-field': ['get', 'name'], 'text-size': 11, 'text-offset': [0, 1.4], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'], 'text-optional': true }, paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
  });
  markers.listeners.add(() => (ctl.map.getSource('d-places') as GeoJSONSource | undefined)?.setData(placesData()));
  ctl.map.on('click', 'd-places-dot', (e) => {
    const id = e.features?.[0]?.properties?.id;
    const x = markers.all().find((k) => k.id === id);
    if (!x) return;
    e.preventDefault();
    const el = document.createElement('div'); el.className = 'wikipop';
    const h = document.createElement('b'); h.textContent = x.name; el.append(h);
    if (x.note && x.note !== x.name) { const p = document.createElement('p'); p.textContent = x.note; el.append(p); }
    for (const b of x.media ?? []) {
      const u = URL.createObjectURL(b);
      const media = b.type.startsWith('audio') ? Object.assign(document.createElement('audio'), { controls: true, src: u }) : b.type.startsWith('video') ? Object.assign(document.createElement('video'), { controls: true, src: u, width: 240 }) : Object.assign(document.createElement('img'), { src: u, width: 240 });
      el.append(media);
    }
    const row = document.createElement('div'); row.className = 'btns sm';
    const btn = (t: string, f: () => void) => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => { pop.remove(); f(); }; row.append(b); };
    btn('Directions', () => ui.set({ place: { id: `my:${x.id}`, name: x.name, address: x.group ?? x.kind, p: x.p, provider: 'osm' } }));
    if (x.kind === 'fav') btn('Marker', () => void markers.put({ kind: 'marker', name: x.name, p: x.p, active: true }));
    if (x.kind === 'marker') btn('Done', () => void markers.update(x.id, { active: false }));
    btn('Delete', () => { if (confirm(`Delete “${x.name}”?`)) void markers.remove(x.id); });
    el.append(row);
    const pop = new Popup({ maxWidth: '280px' }).setLngLat(x.p).setDOMContent(el).addTo(ctl.map);
  });
  const m = ctl.map;
  m.on('moveend', () => { if (mode.current === 'daily' && (dailyMap.settings.wiki || dailyMap.settings.voyage)) refresh(m); });
  m.on('click', 'd-wiki-dot', async (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const title = String(f.properties?.title), site = String(f.properties?.site ?? 'en.wikipedia.org');
    const j = await fetch(`https://${site}/api/rest_v1/page/summary/${encodeURIComponent(title)}`).then((r) => r.json()).catch(() => null);
    const el = document.createElement('div');
    el.className = 'wikipop';
    const h = document.createElement('b'); h.textContent = title; el.append(h);
    if (j?.extract) { const p = document.createElement('p'); p.textContent = j.extract.slice(0, 400); el.append(p); }
    const a = document.createElement('a'); a.href = `https://${site}/wiki/${encodeURIComponent(title)}`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = site.includes('voyage') ? 'Open travel guide (Wikivoyage)' : 'Open in Wikipedia'; el.append(a);
    if (!site.includes('voyage')) { const v = document.createElement('a'); v.href = `https://en.wikivoyage.org/wiki/${encodeURIComponent(title)}`; v.target = '_blank'; v.rel = 'noopener'; v.textContent = ' · Travel guide'; el.append(v); }
    new Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setDOMContent(el).addTo(m);
  });
}
