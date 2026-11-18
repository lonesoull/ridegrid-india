/**
 * Google Maps JavaScript API underlay. Billed per map load (one per app start); panning, zooming and
 * the traffic layer don't create extra loads, and Google refreshes traffic automatically.
 * MapLibre stays on top (transparent) and drives the camera; the Google map follows it exactly.
 */
declare const google: any;
type MLMap = import('maplibre-gl').Map;

let loader: Promise<void> | null = null;
let loadedKey = '';
const authListeners = new Set<() => void>();
export let authFailed = false;

export function loadMapsJs(key: string): Promise<void> {
  if (loader && loadedKey === key) return loader;
  if (loader && loadedKey !== key) return Promise.reject(new Error('A different Google key was already loaded — restart the app to use the new key.'));
  loadedKey = key; authFailed = false;
  (window as any).gm_authFailure = () => { authFailed = true; authListeners.forEach((f) => f()); };
  loader = new Promise<void>((res, rej) => {
    (window as any).__rgMapsReady = () => res();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__rgMapsReady&region=IN&language=en`;
    s.async = true;
    s.onerror = () => { loader = null; rej(new Error('Could not load Google Maps (offline or blocked).')); };
    document.head.appendChild(s);
  });
  return loader;
}
export const onAuthFailure = (f: () => void) => { authListeners.add(f); return () => { authListeners.delete(f); }; };

export class GoogleUnderlay {
  div: HTMLDivElement;
  gmap: any;
  traffic: any = null;
  private sync: () => void;
  /** 'VECTOR' supports rotation + tilt; 'RASTER' (older devices / WebGL off) is north-up and flat */
  renderingType: 'VECTOR' | 'RASTER' | null = null;
  constructor(private ml: MLMap, opts: { night: boolean; traffic: boolean; mapId: string }, onRendering?: (t: 'VECTOR' | 'RASTER') => void) {
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
      disableDefaultUI: true, gestureHandling: 'none', keyboardShortcuts: false, clickableIcons: false,
      isFractionalZoomEnabled: true,
    });
    this.setTraffic(opts.traffic);
    this.gmap.addListener('renderingtype_changed', () => {
      const t = this.gmap.getRenderingType?.();
      if (t === 'VECTOR' || t === 'RASTER') { this.renderingType = t; onRendering?.(t); }
    });
    // Camera match (same as deck.gl's Google overlay): MapLibre tiles are 512 px vs Google's 256 px → zoom + 1;
    // tilt = pitch, heading = bearing; MapLibre's field of view is set to Google's 25° by the caller.
    this.sync = () => {
      const p = ml.getCenter();
      const pitch = ml.getPitch();
      this.gmap.moveCamera({ center: { lat: p.lat, lng: p.lng }, zoom: ml.getZoom() + 1, heading: ml.getBearing(), tilt: pitch });
      // Google limits tilt by zoom level — follow its limit so both cameras stay identical
      const gt = this.gmap.getTilt?.();
      if (typeof gt === 'number' && pitch - gt > 0.5) ml.setPitch(gt);
    };
    ml.on('move', this.sync);
    ml.on('resize', this.sync);
    this.sync();
  }
  setTraffic(on: boolean) {
    if (on && !this.traffic) { this.traffic = new google.maps.TrafficLayer({ autoRefresh: true }); this.traffic.setMap(this.gmap); }
    if (!on && this.traffic) { this.traffic.setMap(null); this.traffic = null; }
  }
  destroy() {
    this.ml.off('move', this.sync); this.ml.off('resize', this.sync);
    this.traffic?.setMap(null);
    this.div.remove();
  }
}
