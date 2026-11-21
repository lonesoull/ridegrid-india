/**
 * Google Maps JavaScript API underlay. Billed per map load (one per app start); panning, zooming and
 * the traffic layer don't create extra loads, and Google refreshes traffic automatically.
 * MapLibre stays on top (transparent). Expedition: MapLibre drives the camera and Google follows.
 * Daily: Google takes the gestures (smooth, like the Google Maps app) and MapLibre follows Google.
 */
declare const google: any;
type MLMap = import('maplibre-gl').Map;
import { MapMouseEvent } from 'maplibre-gl';
/** Marks camera changes that came from the Google map, so they are not sent back to it. */
export const FROM_GOOGLE = { rg: 'g' } as const;
/** "The map stopped moving" in both set-ups (MapLibre-driven or Google-driven). */
export function onMapSettled(ml: MLMap, fn: () => void) {
  ml.on('moveend', (e: any) => { if (e?.rg !== 'g') fn(); });
  ml.on('rg-idle' as any, fn);
}

let loader: Promise<void> | null = null;
let loadedKey = '';
const authListeners = new Set<() => void>();
export let authFailed = false;

export function loadMapsJs(key: string, language = 'en'): Promise<void> {
  if (loader && loadedKey === key) return loader;
  if (loader && loadedKey !== key) return Promise.reject(new Error('A different Google key was already loaded — restart the app to use the new key.'));
  loadedKey = key; authFailed = false;
  (window as any).gm_authFailure = () => { authFailed = true; authListeners.forEach((f) => f()); };
  loader = new Promise<void>((res, rej) => {
    (window as any).__rgMapsReady = () => res();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__rgMapsReady&region=IN&language=${encodeURIComponent(language)}`;
    s.async = true;
    s.onerror = () => { loader = null; rej(new Error('Could not load Google Maps (offline or blocked).')); };
    document.head.appendChild(s);
  });
  return loader;
}
export const onAuthFailure = (f: () => void) => { authListeners.add(f); return () => { authListeners.delete(f); }; };

export interface GoogleBaseOpts { night: boolean; traffic: boolean; mapId: string; mapType?: 'roadmap' | 'satellite' | 'hybrid' | 'terrain'; transit?: boolean; bike?: boolean;
  /** Daily: the Google map takes the finger gestures (Google Maps feel) and our layers follow it */
  drive?: boolean;
  /** a tap on one of Google's own places (shops, petrol pumps…) */
  onPlaceTap?: (placeId: string, p: [number, number]) => void;
  /** finger held still ~0.5 s at a screen point (relative to the map). Return true to take over the finger (drag a stop). */
  onHold?: (x: number, y: number) => boolean;
  onHoldMove?: (x: number, y: number) => void;
  onHoldEnd?: (x: number, y: number) => void }

export class GoogleUnderlay {
  div: HTMLDivElement;
  gmap: any;
  traffic: any = null;
  transit: any = null;
  bike: any = null;
  private sync: (e?: any) => void;
  private settle: () => void;
  /** 'VECTOR' supports rotation + tilt; 'RASTER' (older devices / WebGL off) is north-up and flat */
  renderingType: 'VECTOR' | 'RASTER' | null = null;
  /** largest tilt Google has actually allowed so far (0 = tilt switched off for this Map ID) */
  maxTiltSeen = 0;
  constructor(private ml: MLMap, opts: GoogleBaseOpts, onRendering?: (t: 'VECTOR' | 'RASTER') => void,
    private onTiltLimited?: (asked: number, got: number, zoom: number) => void) {
    const host = ml.getContainer();
    this.div = document.createElement('div');
    this.div.className = 'gmap-underlay';
    host.parentElement!.insertBefore(this.div, host);
    const c = ml.getCenter();
    this.gmap = new google.maps.Map(this.div, {
      center: { lat: c.lat, lng: c.lng }, zoom: ml.getZoom() + 1, heading: ml.getBearing(), tilt: ml.getPitch(),
      mapId: opts.mapId || 'DEMO_MAP_ID',
      renderingType: google.maps.RenderingType?.VECTOR,
      colorScheme: opts.night ? 'DARK' : 'LIGHT',
      disableDefaultUI: true, gestureHandling: opts.drive ? 'greedy' : 'none', keyboardShortcuts: false, clickableIcons: !!opts.drive,
      isFractionalZoomEnabled: true,
      mapTypeId: opts.mapType ?? 'roadmap',
    });
    this.setTraffic(opts.traffic);
    this.setLayers(opts);
    this.gmap.addListener('renderingtype_changed', () => {
      const t = this.gmap.getRenderingType?.();
      if (t === 'VECTOR' || t === 'RASTER') { this.renderingType = t; onRendering?.(t); }
    });
    // Camera match (same as deck.gl's Google overlay): MapLibre tiles are 512 px vs Google's 256 px → zoom + 1;
    // tilt = pitch, heading = bearing; MapLibre's field of view is set to Google's 25° by the caller.
    this.sync = (e?: any) => {
      if (e?.rg === 'g') return; // came from Google: nothing to send back
      const p = ml.getCenter();
      const pitch = ml.getPitch();
      this.gmap.moveCamera({ center: { lat: p.lat, lng: p.lng }, zoom: ml.getZoom() + 1, heading: ml.getBearing(), tilt: pitch });
    };
    // Google limits tilt by zoom level / Map ID. Once a movement finishes, follow its limit so both cameras
    // stay identical (doing this mid-animation would cancel the animation).
    this.settle = () => {
      const pitch = ml.getPitch();
      const gt = this.gmap.getTilt?.();
      if (typeof gt !== 'number') return;
      this.maxTiltSeen = Math.max(this.maxTiltSeen, gt);
      if (pitch - gt > 0.5) { ml.setPitch(gt); this.onTiltLimited?.(pitch, gt, ml.getZoom() + 1); }
    };
    if (opts.drive) this.driveFromGoogle(ml, opts); else ml.on('moveend', this.settle);
    ml.on('move', this.sync);
    ml.on('resize', this.sync);
    this.sync();
  }
  private gl: any[] = [];
  /** Google takes the gestures; MapLibre (our layers) copies Google's camera once per frame, and taps are passed down to it. */
  private driveFromGoogle(ml: MLMap, opts: GoogleBaseOpts) {
    this.drive = true;
    ml.getContainer().classList.add('google-drives');
    let raf = 0;
    // RideGrid's own camera moves (follow while riding, fly to a place…) drive Google meanwhile; copying Google
    // back during them would cancel them, so the copy pauses until they end
    let ours = 0;
    ml.on('movestart', (e: any) => { if (e?.rg !== 'g' && !e?.originalEvent) ours++; });
    ml.on('moveend', (e: any) => { if (e?.rg !== 'g' && !e?.originalEvent) ours = Math.max(0, ours - 1); });
    const copy = () => {
      raf = 0;
      if (ours) return;
      const c = this.gmap.getCenter(); if (!c) return;
      ml.jumpTo({ center: [c.lng(), c.lat()], zoom: (this.gmap.getZoom() ?? 1) - 1, bearing: this.gmap.getHeading?.() ?? 0, pitch: this.gmap.getTilt?.() ?? 0 }, FROM_GOOGLE);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(copy); };
    // Best: draw our layer inside Google's own frame (WebGL overlay) — both maps then move together, no sliding.
    const W = google.maps.WebGLOverlayView;
    if (W) {
      const ov = new W();
      ov.onDraw = ({ transformer }: any) => {
        if (ours) return; // MapLibre is animating and renders itself
        const cp = transformer.getCameraParams();
        ml.jumpTo({ center: [cp.lng, cp.lat], zoom: cp.zoom - 1, bearing: cp.heading, pitch: cp.tilt }, FROM_GOOGLE);
        ml.redraw();
      };
      ov.setMap(this.gmap);
      this.gl.push({ remove: () => ov.setMap(null) });
    }
    // fallback (basic raster Google map has no WebGL overlay): copy the camera on the next frame
    for (const ev of ['center_changed', 'zoom_changed', 'heading_changed', 'tilt_changed']) this.gl.push(this.gmap.addListener(ev, () => { if (!W || this.renderingType === 'RASTER') schedule(); }));
    this.gl.push(this.gmap.addListener('idle', () => { copy(); ml.fire('rg-idle' as any); }));
    this.gl.push(this.gmap.addListener('dragstart', () => { if (ours) { ml.stop(); ours = 0; } ml.fire('dragstart'); }));
    // taps / long-presses: Google's own places open our place card; anything else goes to our layers (stops, favourites…)
    const pass = (type: 'click' | 'contextmenu') => (e: any) => {
      if (type === 'click' && e.placeId && opts.onPlaceTap) { e.stop?.(); opts.onPlaceTap(e.placeId, [e.latLng.lng(), e.latLng.lat()]); return; }
      if (!e.latLng) return;
      const pt = ml.project([e.latLng.lng(), e.latLng.lat()]);
      const r = ml.getCanvasContainer().getBoundingClientRect();
      ml.fire(new MapMouseEvent(type, ml, new MouseEvent(type, { clientX: r.left + pt.x, clientY: r.top + pt.y })));
    };
    // long-press (touch): drop a pin, or — held on a stop — drag that stop while Google pauses its gestures
    let lastHold = 0;
    const ctxPass = pass('contextmenu');
    this.gl.push(this.gmap.addListener('click', pass('click')), this.gmap.addListener('contextmenu', (e: any) => { if (Date.now() - lastHold > 1000) ctxPass(e); }));
    const el = this.div;
    let timer = 0, sx = 0, sy = 0, holding = false, pid = -1;
    const rel = (e: PointerEvent) => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
    const cancel = () => { clearTimeout(timer); timer = 0; };
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' || !e.isPrimary) { cancel(); return; }
      cancel(); sx = e.clientX; sy = e.clientY; pid = e.pointerId;
      timer = window.setTimeout(() => {
        timer = 0; lastHold = Date.now();
        const [x, y] = rel(e);
        navigator.vibrate?.(25);
        if (opts.onHold?.(x, y)) { holding = true; this.gmap.setOptions({ gestureHandling: 'none' }); }
        else {
          const r = ml.getCanvasContainer().getBoundingClientRect();
          ml.fire(new MapMouseEvent('contextmenu', ml, new MouseEvent('contextmenu', { clientX: r.left + x, clientY: r.top + y })));
        }
      }, 500);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      if (holding) { e.preventDefault(); e.stopPropagation(); const [x, y] = rel(e); opts.onHoldMove?.(x, y); return; }
      if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pid) return;
      cancel();
      if (holding) { holding = false; e.stopPropagation(); const [x, y] = rel(e); opts.onHoldEnd?.(x, y); this.gmap.setOptions({ gestureHandling: 'greedy' }); }
    };
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
    this.gl.push({ remove: () => { el.removeEventListener('pointerdown', down, true); window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); } });
  }
  drive = false;
  setTraffic(on: boolean) {
    if (on && !this.traffic) { this.traffic = new google.maps.TrafficLayer({ autoRefresh: true }); this.traffic.setMap(this.gmap); }
    if (!on && this.traffic) { this.traffic.setMap(null); this.traffic = null; }
  }
  /** Map type and Google's own transit / cycling layers (no extra map loads). */
  setLayers(o: Pick<GoogleBaseOpts, 'mapType' | 'transit' | 'bike'>) {
    if (o.mapType && this.gmap.getMapTypeId() !== o.mapType) this.gmap.setMapTypeId(o.mapType);
    if (o.transit && !this.transit) { this.transit = new google.maps.TransitLayer(); this.transit.setMap(this.gmap); }
    if (!o.transit && this.transit) { this.transit.setMap(null); this.transit = null; }
    if (o.bike && !this.bike) { this.bike = new google.maps.BicyclingLayer(); this.bike.setMap(this.gmap); }
    if (!o.bike && this.bike) { this.bike.setMap(null); this.bike = null; }
  }
  destroy() {
    this.ml.off('move', this.sync); this.ml.off('resize', this.sync); this.ml.off('moveend', this.settle);
    this.gl.forEach((l) => l.remove()); this.gl = [];
    this.ml.getContainer().classList.remove('google-drives');
    this.traffic?.setMap(null); this.transit?.setMap(null); this.bike?.setMap(null);
    this.div.remove();
  }
}
