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

export interface GoogleBaseOpts { night: boolean; traffic: boolean; mapId: string; mapType?: 'roadmap' | 'satellite' | 'hybrid' | 'terrain'; transit?: boolean; bike?: boolean }

export class GoogleUnderlay {
  div: HTMLDivElement;
  gmap: any;
  traffic: any = null;
  transit: any = null;
  bike: any = null;
  private sync: () => void;
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
      disableDefaultUI: true, gestureHandling: 'none', keyboardShortcuts: false, clickableIcons: false,
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
    this.sync = () => {
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
    ml.on('moveend', this.settle);
    ml.on('move', this.sync);
    ml.on('resize', this.sync);
    this.sync();
  }
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
    this.traffic?.setMap(null); this.transit?.setMap(null); this.bike?.setMap(null);
    this.div.remove();
  }
}
