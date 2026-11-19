import { ui, toast } from '../ui/state';
import { mode } from '../core/mode';
import { switchMode } from '../core/trips';
import { markers } from './markers';
import { recorder } from './recorder';
import { myLocation } from '../nav/directions';
import { locationFromText } from './coords';

/**
 * Launch actions (OsmAnd launcher shortcuts + "open with"): ?go=home|work|<favourite>, ?do=rec|park,
 * and shared locations (Google Maps links, geo: URIs, "lat,lng" text) via ?share= / ?geo=.
 */
export async function handleLaunch() {
  const q = new URLSearchParams(location.search);
  const go = q.get('go'), act = q.get('do');
  const shared = q.get('share') ?? q.get('text') ?? q.get('url') ?? q.get('geo') ?? q.get('title');
  if (!go && !act && !shared) return;
  history.replaceState(null, '', location.pathname + location.hash);
  if (mode.current !== 'daily') await switchMode('daily');
  if (go) {
    const want = go.toLowerCase();
    const f = markers.favourites().find((x) => x.name.toLowerCase() === want) ?? markers.favourites().find((x) => x.name.toLowerCase().includes(want));
    if (!f) { toast(`Save a favourite called “${go}” first (Places tab)`, 'error'); return; }
    ui.set({ place: { id: `my:${f.id}`, name: f.name, address: f.group ?? '', p: f.p, provider: 'osm' } });
  }
  if (act === 'rec') { await recorder.start(); toast('Recording track'); }
  if (act === 'park') { const p = await myLocation(); await markers.put({ kind: 'parking', name: 'My bike', p }); toast('Parking spot saved'); }
  if (shared) {
    const p = locationFromText(shared);
    if (!p) { toast('No location found in the shared link', 'error'); return; }
    ui.set({ place: { id: `shared:${p}`, name: 'Shared location', address: shared.slice(0, 80), p, provider: 'osm' } });
  }
}

export { locationFromText } from './coords';

/** Android app: geo: links opened with RideGrid arrive here. */
export async function listenAppLinks() {
  const { Capacitor } = await import('@capacitor/core');
  if (!Capacitor.isNativePlatform()) return;
  const { App } = await import('@capacitor/app');
  const open = async (url?: string) => {
    if (!url?.startsWith('geo:')) return;
    const p = locationFromText(url);
    if (!p) return;
    if (mode.current !== 'daily') await switchMode('daily');
    ui.set({ place: { id: `shared:${p}`, name: 'Shared location', address: url.slice(0, 80), p, provider: 'osm' } });
  };
  void App.getLaunchUrl().then((r) => open(r?.url)).catch(() => {});
  void App.addListener('appUrlOpen', (e) => void open(e.url));
}
