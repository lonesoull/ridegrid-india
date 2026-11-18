import { Map as MLMap, setWorkerUrl, type GeoJSONSource, type MapMouseEvent, type MapTouchEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { GoogleUnderlay } from './googleJs';
import { nav } from '../nav/navigator';
import { engine, type Leg, type LegDiff } from '../core/engine';
import { bounds, type LngLat } from '../core/geo';
import { ui, toast, act } from '../ui/state';
import { app } from '../core/app';

setWorkerUrl(new URL(workerUrl, location.href).href);

export const STYLES = {
  day: 'https://tiles.openfreemap.org/styles/liberty',
  night: 'https://tiles.openfreemap.org/styles/dark',
};

const ROUTE = 'rg-route', STOPS = 'rg-stops', DRAG = 'rg-drag', SEL = 'rg-sel', ME = 'rg-me', TRACK = 'rg-track', PUCK = 'rg-puck', NEXT = 'rg-next', APPROACH = 'rg-approach', ISSUES = 'rg-issues', PLACES = 'rg-places', PEERS = 'rg-peers', PEERTRK = 'rg-peer-tracks', BANNED = 'rg-banned', RIDDEN = 'rg-ridden';
export const ROLE_COLOR: Record<string, string> = { primary: '#f97316', secondary: '#14b8a6', laptop: '#64748b' };
const FONT = ['Noto Sans Bold'];
const empty = (): GeoJSON.FeatureCollection => ({ type: 'FeatureCollection', features: [] });

function legFeature(l: Leg): GeoJSON.Feature {
  return {
    type: 'Feature', id: l.fid,
    properties: { st: l.status },
    geometry: { type: 'LineString', coordinates: l.status === 'ok' && l.coords ? l.coords : [l.from, l.to] },
  };
}

const lineFeature = (c: LngLat[]): GeoJSON.Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } });

/** Navigation arrow (drawn once into an image, rotated on the GPU). */
function arrowImage(color = '#0ea5e9') {
  const size = 64, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  g.beginPath(); g.arc(0, 0, 26, 0, Math.PI * 2); g.fillStyle = '#ffffff'; g.fill();
  g.beginPath(); g.arc(0, 0, 22, 0, Math.PI * 2); g.fillStyle = color; g.fill();
  g.beginPath(); g.moveTo(0, -16); g.lineTo(12, 13); g.lineTo(0, 6); g.lineTo(-12, 13); g.closePath(); g.fillStyle = '#ffffff'; g.fill();
  return c.getContext("2d")!.getImageData(0, 0, size, size);
}

/** Fallback raster style used when vector tiles are unreachable (keeps the app usable). */
const fallbackStyle: StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#1b2330' } }],
};

export class MapController {
  map: MLMap;
  private stopsDirty = false;
  private stopsInFlight = false;
  private drag: { id: string; i: number } | null = null;
  private me: LngLat | null = null;
  private styleReady = false;
  private pendingDiffs: LegDiff[] = [];

  constructor(container: HTMLElement) {
    const night = ui.get().night;
    this.map = new MLMap({
      container,
      style: night ? STYLES.night : STYLES.day,
      center: [78.9629, 22.5937],
      zoom: 4.2,
      maxPitch: 80,
      attributionControl: { compact: true },
      fadeDuration: 0,
      canvasContextAttributes: { antialias: true },
    } as any);
    this.map.on('style.load', () => this.installLayers());
    this.map.on('error', (e: any) => {
      if (String(e?.error?.message || '').match(/Failed to fetch|NetworkError|style/i) && !this.styleReady) {
        this.map.setStyle(fallbackStyle);
      }
    });
    engine.subscribe((e) => {
      if (e.stops) this.scheduleStops();
      if (e.legs) this.applyLegDiff(e.legs);
    });
    ui.subscribe(() => this.syncSelection());
    this.bindInteractions();
  }

  /** Identifies the current basemap so identical requests don't reload the style. */
  private baseId = `osm:${ui.get().night ? 'night' : 'day'}`;
  base: 'osm' | 'google' = 'osm';

  /** OpenStreetMap vector basemap (works offline from cache). */
  setOsmBase(night: boolean) { this.dropUnderlay(); this.applyBase(`osm:${night ? 'night' : 'day'}`, night ? STYLES.night : STYLES.day, 'osm'); }

  /** Google mode: transparent MapLibre over a Google Maps JavaScript map (flat, rotates with heading). */
  private underlay: GoogleUnderlay | null = null;
  private underlayKey = '';
  setGoogleJsBase(opts: { night: boolean; traffic: boolean; mapId: string }) {
    const key = `${opts.night}|${opts.mapId}`;
    if (!this.underlay || this.underlayKey !== key) {
      this.underlay?.destroy();
      this.underlay = new GoogleUnderlay(this.map, opts, (t) => this.onGoogleRendering(t), (asked, got, gz) => this.onTiltLimited(asked, got, gz));
      this.underlayKey = key;
    } else this.underlay.setTraffic(opts.traffic);
    // match Google's camera exactly: 25° vertical field of view, tilt up to Google's 67.5°
    this.map.setVerticalFieldOfView(25);
    this.map.setMaxPitch(this.underlay.renderingType === 'RASTER' ? 0 : 67.5);
    this.map.getContainer().classList.add('over-google');
    const style: StyleSpecification = { version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sources: {}, layers: [] };
    this.applyBase('google-js', style, 'google');
  }
  /** Basic (raster) Google map can't rotate or tilt — keep ours north-up and flat so they stay aligned. */
  private onGoogleRendering(t: 'VECTOR' | 'RASTER') {
    if (t === 'RASTER') {
      this.map.setMaxPitch(0);
      this.map.setBearing(0);
      this.map.dragRotate.disable(); this.map.touchZoomRotate.disableRotation();
      toast('Google map is in basic mode on this device (no WebGL vector map) — rotation and 3D tilt are off in Google mode.');
    } else {
      this.map.setMaxPitch(67.5);
      this.map.dragRotate.enable(); this.map.touchZoomRotate.enableRotation();
    }
  }
  private lastTiltMsg = 0;
  /** Google refused (part of) the requested tilt — explain instead of silently staying flat. */
  private onTiltLimited(asked: number, got: number, gZoom: number) {
    if (asked < 10 || Date.now() - this.lastTiltMsg < 8000) return;
    this.lastTiltMsg = Date.now();
    if (got < 1 && (this.underlay?.maxTiltSeen ?? 0) < 1) {
      toast('Google won\'t tilt with this Map ID. Create your own Vector Map ID with Tilt + Rotation (Tools → Google Maps mode → Map ID) for 3D.', 'error');
    } else if (got < 1) {
      toast(`Zoom in to tilt — Google allows 3D only when closer (now zoom ${gZoom.toFixed(0)}).`);
    } else if (asked - got > 5) {
      toast(`Google allows ${Math.round(got)}° tilt at this zoom — zoom in for more 3D.`);
    }
  }
  /** For the Tools panel: what the Google map can do on this device. */
  get googleStatus() {
    if (this.base !== 'google' || !this.underlay) return null;
    return { rendering: this.underlay.renderingType, maxTilt: this.underlay.maxTiltSeen };
  }

  get rotationLocked() { return this.base === 'google' && this.underlay?.renderingType === 'RASTER'; }

  private dropUnderlay() {
    this.underlay?.destroy(); this.underlay = null; this.underlayKey = '';
    this.map.setVerticalFieldOfView(36.87);
    this.map.dragRotate.enable(); this.map.touchZoomRotate.enableRotation();
    this.map.setMaxPitch(80);
    this.map.getContainer().classList.remove('over-google');
  }

  private applyBase(id: string, style: string | StyleSpecification, kind: 'osm' | 'google') {
    if (id === this.baseId) return;
    this.baseId = id; this.base = kind;
    this.styleReady = false;
    this.map.setStyle(style, { diff: false });
  }

  // ---------- layers ----------
  private installLayers() {
    const m = this.map;
    const night = ui.get().night;
    m.addSource(ROUTE, { type: 'geojson', data: empty(), lineMetrics: false, tolerance: 0.2, buffer: 64 });
    m.addSource(STOPS, {
      type: 'geojson', data: empty(), cluster: true, clusterMaxZoom: 11, clusterRadius: 48,
      clusterProperties: { lo: ['min', ['get', 'n']], hi: ['max', ['get', 'n']] },
    } as any);
    m.addSource(DRAG, { type: 'geojson', data: empty() });
    m.addSource(SEL, { type: 'geojson', data: empty() });
    m.addSource(ME, { type: 'geojson', data: empty() });

    m.addLayer({ id: 'rg-route-casing', type: 'line', source: ROUTE, filter: ['==', ['get', 'st'], 'ok'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': night ? '#001a33' : '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3, 10, 7, 16, 12] } });
    m.addLayer({ id: 'rg-route-line', type: 'line', source: ROUTE, filter: ['==', ['get', 'st'], 'ok'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#1e90ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.6, 10, 4, 16, 7] } });
    m.addLayer({ id: 'rg-route-pending', type: 'line', source: ROUTE, filter: ['!=', ['get', 'st'], 'ok'],
      paint: {
        'line-color': ['match', ['get', 'st'], 'error', '#ef4444', night ? '#94a3b8' : '#64748b'],
        'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.8,
      } });
    m.addLayer({ id: 'rg-drag-line', type: 'line', source: DRAG, filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-dasharray': [1, 1] } });

    m.addLayer({ id: 'rg-clusters', type: 'circle', source: STOPS, filter: ['has', 'point_count'],
      paint: {
        'circle-color': '#1e90ff', 'circle-opacity': 0.88, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
        'circle-radius': ['step', ['get', 'point_count'], 16, 100, 20, 1000, 26, 10000, 32],
      } });
    m.addLayer({ id: 'rg-cluster-label', type: 'symbol', source: STOPS, filter: ['has', 'point_count'],
      layout: {
        'text-field': ['format', ['get', 'point_count_abbreviated'], { 'font-scale': 1 }, '\n', {},
          ['concat', '#', ['to-string', ['get', 'lo']], '–', ['to-string', ['get', 'hi']]], { 'font-scale': 0.62 }],
        'text-font': FONT, 'text-size': 13, 'text-allow-overlap': true, 'text-line-height': 1.05,
      },
      paint: { 'text-color': '#ffffff' } });
    m.addLayer({ id: 'rg-stop-pts', type: 'circle', source: STOPS, filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 7, 14, 11],
        'circle-color': ['match', ['get', 'r'], 0, '#22c55e', 2, '#ef4444', '#1e90ff'],
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2,
      } });
    m.addLayer({ id: 'rg-stop-label', type: 'symbol', source: STOPS, filter: ['!', ['has', 'point_count']],
      layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 8, 9, 14, 12], 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#ffffff' } });
    m.addLayer({ id: 'rg-sel', type: 'circle', source: SEL,
      paint: { 'circle-radius': 18, 'circle-color': 'rgba(245,158,11,0.25)', 'circle-stroke-color': '#f59e0b', 'circle-stroke-width': 3 } });
    m.addLayer({ id: 'rg-drag-pt', type: 'circle', source: DRAG, filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 12, 'circle-color': '#f59e0b', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    m.addLayer({ id: 'rg-me', type: 'circle', source: ME,
      paint: { 'circle-radius': 9, 'circle-color': '#0ea5e9', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });

    // ---- navigation layers (Phase 2)
    m.addSource(APPROACH, { type: 'geojson', data: this.approach ? lineFeature(this.approach) : empty() });
    m.addLayer({ id: 'rg-approach-casing', type: 'line', source: APPROACH, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4, 14, 9] } }, 'rg-clusters');
    m.addLayer({ id: 'rg-approach', type: 'line', source: APPROACH, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#f97316', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2.5, 14, 6], 'line-dasharray': [1.5, 1] } }, 'rg-clusters');
    m.addSource(PLACES, { type: 'geojson', data: this.placesFc ?? empty() });
    m.addLayer({ id: 'rg-places', type: 'circle', source: PLACES,
      paint: { 'circle-radius': ['case', ['get', 'sel'], 12, 8], 'circle-color': ['case', ['get', 'sel'], '#db2777', '#a855f7'], 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    m.addLayer({ id: 'rg-places-label', type: 'symbol', source: PLACES, minzoom: 11,
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.3], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#7e22ce', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
    m.addSource(ISSUES, { type: 'geojson', data: this.issues ?? empty() });
    m.addLayer({ id: 'rg-issues-link', type: 'line', source: ISSUES, filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': '#dc2626', 'line-width': 2, 'line-dasharray': [1, 1] } });
    m.addLayer({ id: 'rg-issues', type: 'circle', source: ISSUES, filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 4, 14, 10], 'circle-color': ['match', ['get', 'k'], 'parallel', '#f59e0b', '#dc2626'],
        'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    m.addSource(TRACK, { type: 'geojson', data: empty() });
    m.addSource(NEXT, { type: 'geojson', data: empty() });
    m.addSource(PUCK, { type: 'geojson', data: empty() });
    // ridden track goes UNDER the planned route (wider, translucent) so any difference stays visible
    m.addLayer({ id: 'rg-track', type: 'line', source: TRACK, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#dc143c', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 5, 14, 13], 'line-opacity': 0.55 } }, 'rg-route-casing');
    m.addLayer({ id: 'rg-next', type: 'circle', source: NEXT,
      paint: { 'circle-radius': 20, 'circle-color': 'rgba(34,197,94,0.18)', 'circle-stroke-color': '#22c55e', 'circle-stroke-width': 4 } });
    if (!m.hasImage('rg-arrow')) m.addImage('rg-arrow', arrowImage(), { pixelRatio: 2 });
    for (const [role, col] of Object.entries(ROLE_COLOR)) if (!m.hasImage(`rg-arrow-${role}`)) m.addImage(`rg-arrow-${role}`, arrowImage(col), { pixelRatio: 2 });
    // roads already ridden on this trip (crimson) and two-wheeler-banned expressways (dark red, dashed)
    m.addSource(RIDDEN, { type: 'geojson', data: this.riddenFc ?? empty() });
    m.addLayer({ id: 'rg-ridden', type: 'line', source: RIDDEN, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#dc143c', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2, 14, 7], 'line-opacity': 0.6 } }, 'rg-route-casing');
    m.addSource(BANNED, { type: 'geojson', data: this.bannedFc ?? empty() });
    m.addLayer({ id: 'rg-banned', type: 'line', source: BANNED, minzoom: 6,
      paint: { 'line-color': '#7f1d1d', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.5, 14, 5], 'line-dasharray': [2, 1.5], 'line-opacity': 0.8 } }, 'rg-route-casing');
    // team devices: their ridden tracks and live arrows
    m.addSource(PEERTRK, { type: 'geojson', data: this.peerFc?.tracks ?? empty() });
    m.addLayer({ id: 'rg-peer-tracks', type: 'line', source: PEERTRK, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'col'], 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 14, 5], 'line-opacity': 0.75 } }, 'rg-clusters');
    m.addSource(PEERS, { type: 'geojson', data: this.peerFc?.pts ?? empty() });
    m.addLayer({ id: 'rg-peers', type: 'symbol', source: PEERS,
      layout: { 'icon-image': ['concat', 'rg-arrow-', ['get', 'role']], 'icon-rotate': ['get', 'hd'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'text-field': ['get', 'label'], 'text-font': FONT, 'text-size': 12, 'text-offset': [0, 1.6], 'text-anchor': 'top', 'text-allow-overlap': true },
      paint: { 'text-color': ['get', 'col'], 'text-halo-color': '#fff', 'text-halo-width': 1.5, 'icon-opacity': ['case', ['get', 'stale'], 0.45, 1] } });
    m.addLayer({ id: 'rg-puck-halo', type: 'circle', source: PUCK,
      paint: { 'circle-radius': ['get', 'accPx'], 'circle-color': 'rgba(14,165,233,0.12)', 'circle-stroke-color': 'rgba(14,165,233,0.4)', 'circle-stroke-width': 1 } });
    m.addLayer({ id: 'rg-puck', type: 'symbol', source: PUCK,
      layout: { 'icon-image': 'rg-arrow', 'icon-rotate': ['get', 'hd'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } });

    this.styleReady = true;
    this.pendingDiffs = [];
    this.rebuildRoute();
    this.scheduleStops();
    this.syncSelection();
    if (this.me) this.showMe(this.me, false);
  }

  private src(id: string) { return this.map.getSource(id) as GeoJSONSource | undefined; }

  private rebuildRoute() {
    const features: GeoJSON.Feature[] = [];
    for (const l of engine.legs.values()) features.push(legFeature(l));
    void this.src(ROUTE)?.setData({ type: 'FeatureCollection', features });
  }

  private applyLegDiff(d: LegDiff) {
    if (!this.styleReady) return; // installLayers will rebuild everything
    const big = d.add.length + d.remove.length > 4000;
    if (big) { this.rebuildRoute(); return; }
    this.pendingDiffs.push(d);
    if (this.pendingDiffs.length === 1) requestAnimationFrame(() => this.flushDiffs());
  }

  /** Coalesce many small leg updates (router results, edits) into one GPU upload per frame. */
  private flushDiffs() {
    const diffs = this.pendingDiffs; this.pendingDiffs = [];
    const s = this.src(ROUTE);
    if (!s || !diffs.length) return;
    const removed = new Set<number>(); const added = new Map<number, Leg>(); const updated = new Map<number, Leg>();
    for (const d of diffs) {
      d.remove.forEach((l) => { if (added.delete(l.fid)) return; updated.delete(l.fid); removed.add(l.fid); });
      d.add.forEach((l) => added.set(l.fid, l));
      d.update.forEach((l) => { if (added.has(l.fid)) added.set(l.fid, l); else if (!removed.has(l.fid)) updated.set(l.fid, l); });
    }
    void s.updateData({
      remove: [...removed],
      add: [...added.values()].map(legFeature),
      update: [...updated.values()].map((l) => ({
        id: l.fid,
        newGeometry: legFeature(l).geometry,
        addOrUpdateProperties: [{ key: 'st', value: l.status }],
      })),
    }).catch(() => this.rebuildRoute());
  }

  private scheduleStops() {
    this.stopsDirty = true;
    if (!this.stopsInFlight) requestAnimationFrame(() => this.pushStops());
  }

  private async pushStops() {
    const s = this.src(STOPS);
    if (!s || !this.stopsDirty) return;
    this.stopsDirty = false; this.stopsInFlight = true;
    const S = engine.stops, last = S.length - 1;
    const features: GeoJSON.Feature[] = new Array(S.length);
    for (let i = 0; i < S.length; i++) {
      features[i] = { type: 'Feature', properties: { n: i + 1, id: S[i].id, r: i === 0 ? 0 : i === last ? 2 : 1 }, geometry: { type: 'Point', coordinates: [S[i].lng, S[i].lat] } };
    }
    try { await s.setData({ type: 'FeatureCollection', features }); } finally {
      this.stopsInFlight = false;
      if (this.stopsDirty) requestAnimationFrame(() => this.pushStops());
    }
    this.syncSelection();
  }

  private syncSelection() {
    const id = ui.get().selectedId;
    const i = id ? engine.indexOf(id) : -1;
    const s = engine.stops[i];
    this.src(SEL)?.setData(s ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } } : empty());
  }

  // ---------- navigation drawing ----------
  follow = true;
  private lastCam = 0;
  setNav(state: { pos: LngLat | null; heading: number; accuracy: number; next: LngLat | null; track: LngLat[] } | null, sim = false) {
    if (!this.styleReady) return;
    if (!state) {
      for (const id of [TRACK, PUCK, NEXT]) this.src(id)?.setData(empty());
      return;
    }
    const { pos, heading, accuracy, next, track } = state;
    const mpp = 156543.03 * Math.cos(((pos?.[1] ?? 20) * Math.PI) / 180) / 2 ** this.map.getZoom();
    this.src(PUCK)?.setData(pos ? { type: 'Feature', properties: { hd: heading, accPx: Math.min(120, Math.max(0, accuracy / mpp)) }, geometry: { type: 'Point', coordinates: pos } } : empty());
    this.src(NEXT)?.setData(next ? { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: next } } : empty());
    this.src(TRACK)?.setData(track.length > 1 ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: track } } : empty());
    if (pos && this.follow && !this.drag) {
      const now = performance.now();
      // first follow frame (or after zooming far out): bring the camera down to riding view
      const cam = this.map.getZoom() < 13 ? { zoom: 15.5, pitch: 55 } : {};
      if (sim) this.map.jumpTo({ center: pos, bearing: heading, ...cam });
      else if (now - this.lastCam > 500 || 'zoom' in cam) { this.lastCam = now; this.map.easeTo({ center: pos, bearing: heading, duration: 900, ...cam }); }
    }
  }
  private bannedFc: GeoJSON.FeatureCollection | null = null;
  setBanned(fc: GeoJSON.FeatureCollection | null) { this.bannedFc = fc; this.src(BANNED)?.setData(fc ?? empty()); }
  private riddenFc: GeoJSON.FeatureCollection | null = null;
  setRidden(lines: LngLat[][]) {
    this.riddenFc = { type: 'FeatureCollection', features: lines.filter((l) => l.length > 1).map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } })) };
    this.src(RIDDEN)?.setData(this.riddenFc);
  }

  // ---------- team devices ----------
  private peerFc: { pts: GeoJSON.FeatureCollection; tracks: GeoJSON.FeatureCollection } | null = null;
  followPeerId: string | null = null;
  setPeers(list: { id: string; name: string; role: string; pos?: LngLat; hd?: number; spd?: number; lastSeen: number; track: LngLat[]; online: boolean }[]) {
    const now = Date.now();
    this.peerFc = {
      pts: { type: 'FeatureCollection', features: list.filter((p) => p.pos && p.online).map((p) => ({ type: 'Feature', properties: {
        role: p.role, hd: p.hd ?? 0, col: ROLE_COLOR[p.role] ?? '#64748b', stale: now - p.lastSeen > 30000,
        label: `${p.name}${p.spd ? ` · ${Math.round(p.spd * 3.6)} km/h` : ''}` }, geometry: { type: 'Point', coordinates: p.pos! } })) },
      tracks: { type: 'FeatureCollection', features: list.filter((p) => p.track.length > 1).map((p) => ({ type: 'Feature', properties: { col: ROLE_COLOR[p.role] ?? '#64748b' }, geometry: { type: 'LineString', coordinates: p.track } })) },
    };
    this.src(PEERS)?.setData(this.peerFc.pts);
    this.src(PEERTRK)?.setData(this.peerFc.tracks);
    const f = this.followPeerId && list.find((p) => p.id === this.followPeerId);
    if (f && f.pos && nav.mode === 'off') this.map.easeTo({ center: f.pos, bearing: f.hd ?? this.map.getBearing(), zoom: Math.max(this.map.getZoom(), 14.5), duration: 800 });
  }

  private placesFc: GeoJSON.FeatureCollection | null = null;
  /** Search results on the map (selected one highlighted); fits them into view. */
  setPlaces(list: { id: string; name: string; p?: LngLat }[], selected: string | null, fit = true) {
    const pts = list.filter((x) => x.p);
    this.placesFc = { type: 'FeatureCollection', features: pts.map((x) => ({ type: 'Feature', properties: { id: x.id, name: x.name, sel: x.id === selected }, geometry: { type: 'Point', coordinates: x.p! } })) };
    this.src(PLACES)?.setData(this.placesFc);
    if (fit && pts.length > 1 && !selected) {
      const b = bounds(pts.map((x) => x.p!));
      if (b) this.map.fitBounds(b, { padding: { top: 140, bottom: 80, left: 60, right: 90 }, maxZoom: 15, duration: 600 });
    }
  }

  private issues: GeoJSON.FeatureCollection | null = null;
  /** Route-checker results as red (crossing/close/overlap) and amber (parallel) markers. */
  setIssues(list: { kind: string; p: LngLat; p2: LngLat }[] | null) {
    this.issues = list ? { type: 'FeatureCollection', features: list.flatMap((x) => [
      { type: 'Feature', properties: { k: x.kind }, geometry: { type: 'Point', coordinates: x.p } } as GeoJSON.Feature,
      { type: 'Feature', properties: { k: x.kind }, geometry: { type: 'LineString', coordinates: [x.p, x.p2] } } as GeoJSON.Feature,
    ]) } : null;
    this.src(ISSUES)?.setData(this.issues ?? empty());
  }

  private approach: LngLat[] | null = null;
  /** Orange dashed "how to get there" path from the rider to a stop. */
  setApproach(coords: LngLat[] | null, fit = false) {
    this.approach = coords;
    this.src(APPROACH)?.setData(coords && coords.length > 1 ? lineFeature(coords) : empty());
    if (coords && fit) {
      const b = bounds(coords);
      if (b) this.map.fitBounds(b, { padding: { top: 110, bottom: 330, left: 60, right: 90 }, maxZoom: 16, duration: 700 });
    }
  }
  startFollow(pos?: LngLat | null) {
    this.follow = true;
    this.map.jumpTo({ center: pos ?? this.map.getCenter(), zoom: Math.max(this.map.getZoom(), 15.5), pitch: 55 });
  }

  // ---------- camera ----------
  fitRoute() {
    const b = bounds((function* () { for (const s of engine.stops) yield [s.lng, s.lat] as LngLat; })());
    if (!b) { toast('No stops yet'); return; }
    this.map.fitBounds(b, { padding: { top: 90, bottom: 90, left: 60, right: 60 }, maxZoom: 15, duration: 700 });
  }
  flyToStop(i: number) {
    const s = engine.stops[i];
    if (!s) return;
    ui.set({ selectedId: s.id });
    this.map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(this.map.getZoom(), 14), duration: 700 });
  }
  snapView() { this.follow = false; ui.set({ following: false }); this.map.easeTo({ pitch: 0, bearing: 0, duration: 500 }); }
  tilt() {
    if (this.rotationLocked) { toast('3D tilt needs Google\'s vector map, which this device can\'t show. Turn Google mode off for 3D.'); return; }
    const flat = this.map.getPitch() > 10;
    const zoomFor3d = this.base === 'google' && !flat ? { zoom: Math.max(this.map.getZoom(), 16.5) } : {};
    this.map.easeTo({ pitch: flat ? 0 : 60, duration: 600, ...zoomFor3d });
  }
  showMe(p: LngLat, fly = true) {
    this.me = p;
    this.src(ME)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } });
    if (fly) this.map.flyTo({ center: p, zoom: Math.max(this.map.getZoom(), 14) });
  }

  // ---------- interactions ----------
  private async snap(p: LngLat): Promise<LngLat> {
    if (!ui.get().snapToRoad || !navigator.onLine) return p;
    return (await app.queue.providerFor([p]).nearest(p)) ?? p;
  }

  private hitStop(point: { x: number; y: number }, pad = 10) {
    if (!this.styleReady) return undefined;
    return this.map.queryRenderedFeatures([[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]], { layers: ['rg-stop-pts'] })[0];
  }

  private bindInteractions() {
    const m = this.map;
    // user pans the map → stop auto-follow (a re-centre button brings it back)
    m.on('dragstart', () => { if (!this.drag) { this.follow = false; ui.set({ following: false }); } });
    m.on('click', async (e) => {
      if (!this.styleReady) return;
      const pad = 12;
      const box: [[number, number], [number, number]] = [[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]];
      const cl = m.queryRenderedFeatures(box, { layers: ['rg-clusters'] })[0];
      if (cl) {
        const z = await (this.src(STOPS) as any).getClusterExpansionZoom(cl.properties!.cluster_id);
        m.easeTo({ center: (cl.geometry as GeoJSON.Point).coordinates as LngLat, zoom: z + 0.5 });
        return;
      }
      const pl = m.queryRenderedFeatures(box, { layers: ['rg-places'] })[0];
      if (pl) { const found = ui.get().places.find((x) => x.id === pl.properties!.id); if (found) { ui.set({ place: found, selectedId: null }); return; } }
      const st = this.hitStop(e.point, pad);
      if (st) { ui.set({ selectedId: st.properties!.id, drawer: false }); return; }
      const insertAt = ui.get().insertAt;
      if (insertAt !== null) {
        const p = await this.snap([e.lngLat.lng, e.lngLat.lat]);
        ui.set({ insertAt: null });
        await act(null, () => engine.addStop(p, insertAt));
        const s = engine.stops[insertAt];
        if (s) ui.set({ selectedId: s.id });
        return;
      }
      if (ui.get().selectedId) { ui.set({ selectedId: null }); return; }
      const mode = ui.get().tapMode;
      if (mode === 'off') return;
      const raw: LngLat = [e.lngLat.lng, e.lngLat.lat];
      const leg = mode === 'insert' ? m.queryRenderedFeatures(box, { layers: ['rg-route-line', 'rg-route-pending'] })[0] : undefined;
      await act(null, async () => {
        const p = await this.snap(raw);
        if (leg) {
          const l = [...engine.legs.values()].find((x) => x.fid === leg.id);
          if (l) { await engine.insertOnLeg(l.key, p); return; }
        }
        await engine.addStop(p);
      });
    });

    m.on('mouseenter', 'rg-stop-pts', () => { m.getCanvas().style.cursor = 'grab'; });
    m.on('mouseleave', 'rg-stop-pts', () => { m.getCanvas().style.cursor = ''; });
    m.on('mouseenter', 'rg-clusters', () => { m.getCanvas().style.cursor = 'zoom-in'; });
    m.on('mouseleave', 'rg-clusters', () => { m.getCanvas().style.cursor = ''; });

    const start = (e: MapMouseEvent | MapTouchEvent) => {
      if ((e as MapTouchEvent).points && (e as MapTouchEvent).points.length > 1) return;
      const f = this.hitStop(e.point, 14);
      if (!f) return;
      const id = f.properties!.id as string;
      // touch: only drag the selected stop so panning stays easy with gloves
      if ((e as MapTouchEvent).points && ui.get().selectedId !== id) return;
      e.preventDefault();
      this.drag = { id, i: engine.indexOf(id) };
      m.dragPan.disable();
      m.getCanvas().style.cursor = 'grabbing';
    };
    const move = (e: MapMouseEvent | MapTouchEvent) => {
      if (!this.drag) return;
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      const { i } = this.drag;
      const S = engine.stops;
      const feats: GeoJSON.Feature[] = [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }];
      const line: LngLat[] = [];
      if (S[i - 1]) line.push([S[i - 1].lng, S[i - 1].lat]);
      line.push(p);
      if (S[i + 1]) line.push([S[i + 1].lng, S[i + 1].lat]);
      if (line.length > 1) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
      this.src(DRAG)?.setData({ type: 'FeatureCollection', features: feats });
    };
    const end = async (e: MapMouseEvent | MapTouchEvent) => {
      if (!this.drag) return;
      const { id } = this.drag;
      this.drag = null;
      m.dragPan.enable();
      m.getCanvas().style.cursor = '';
      const raw: LngLat = [e.lngLat.lng, e.lngLat.lat];
      await act(null, async () => engine.moveStop(id, await this.snap(raw)));
      this.src(DRAG)?.setData(empty());
    };
    m.on('mousedown', start); m.on('touchstart', start);
    m.on('mousemove', move); m.on('touchmove', move);
    m.on('mouseup', end); m.on('touchend', end);
  }
}
