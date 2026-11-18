import { Popup, type Map as MLMap, type GeoJSONSource } from 'maplibre-gl';
import type { MapController } from '../map/MapController';
import { mode } from '../core/mode';
import { dailyMap, wikiNear } from './mapLayers';

/** Daily-mode overlays that are data, not tiles (Wikipedia places), refreshed as the map moves. */
export function startDailyOverlays(ctl: MapController) {
  let timer = 0;
  const refresh = (m: MLMap) => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const src = m.getSource('d-wiki') as GeoJSONSource | undefined;
      if (!src || m.getZoom() < 10) { src?.setData({ type: 'FeatureCollection', features: [] }); return; }
      src.setData(await wikiNear(m));
    }, 600);
  };
  ctl.styleHooks.add((m) => {
    if (mode.current !== 'daily' || !dailyMap.settings.wiki || m.getSource('d-wiki')) return;
    m.addSource('d-wiki', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    m.addLayer({ id: 'd-wiki-dot', type: 'circle', source: 'd-wiki', paint: { 'circle-radius': 6, 'circle-color': '#fff', 'circle-stroke-color': '#333', 'circle-stroke-width': 2 } });
    m.addLayer({ id: 'd-wiki-label', type: 'symbol', source: 'd-wiki', minzoom: 12,
      layout: { 'text-field': ['get', 'title'], 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'], 'text-optional': true },
      paint: { 'text-color': '#222', 'text-halo-color': '#fff', 'text-halo-width': 1.2 } });
    refresh(m);
  });
  const m = ctl.map;
  m.on('moveend', () => { if (mode.current === 'daily' && dailyMap.settings.wiki) refresh(m); });
  m.on('click', 'd-wiki-dot', async (e) => {
    const f = e.features?.[0];
    if (!f) return;
    const title = String(f.properties?.title);
    const j = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`).then((r) => r.json()).catch(() => null);
    const el = document.createElement('div');
    el.className = 'wikipop';
    const h = document.createElement('b'); h.textContent = title; el.append(h);
    if (j?.extract) { const p = document.createElement('p'); p.textContent = j.extract.slice(0, 400); el.append(p); }
    const a = document.createElement('a'); a.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Open in Wikipedia'; el.append(a);
    new Popup({ maxWidth: '280px' }).setLngLat(e.lngLat).setDOMContent(el).addTo(m);
  });
}
