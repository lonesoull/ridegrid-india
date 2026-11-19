import { nav } from '../nav/navigator';
import { say } from '../nav/audio';
import { haversine, type LngLat } from '../core/geo';
import { offlineSearch } from './offlineSearch';
import { markers } from './markers';
import { dailyNav } from './dailyNav';

/** Voice for places ahead on the route: fuel / food / mechanics within ~2 km, favourites as you pass. */
const said = new Set<string>();
let lastQuery = 0;
const RAD = Math.PI / 180;
const side = (me: LngLat, hd: number, p: LngLat) => {
  const brg = (Math.atan2((p[0] - me[0]) * Math.cos(me[1] * RAD), p[1] - me[1]) / RAD + 360) % 360;
  const d = ((brg - hd + 540) % 360) - 180;
  return Math.abs(d) < 15 ? 'ahead' : d > 0 ? 'on the right' : 'on the left';
};

export async function announceAhead() {
  const a = dailyNav.s.ahead;
  if (!nav.pos || !nav.line || !nav.settings.voice) return;
  const me = nav.pos;
  // favourites within 400 m in front
  if (a.favourites) for (const f of markers.favourites()) {
    const d = haversine(me, f.p);
    if (d < 400 && !said.has(f.id)) {
      said.add(f.id); say(`Passing ${f.name}, ${side(me, nav.heading, f.p)}`); return;
    }
  }
  if (Date.now() - lastQuery < 30000) return;
  lastQuery = Date.now();
  const cats = [a.fuel && 'fuel', a.food && 'restaurant', a.mechanic && 'mechanic'].filter(Boolean) as string[];
  const L = nav.line;
  const pts: LngLat[] = [];
  for (let i = 0; i < L.n; i++) if (L.cum[i] >= nav.s && L.cum[i] <= nav.s + 2500) pts.push([L.x[i], L.y[i]]);
  if (pts.length < 2) return;
  for (const cat of cats) {
    const [h] = await offlineSearch.search('', { cat, along: { pts, maxM: 150 }, limit: 1 });
    if (!h) continue;
    const key = `${h.p[0]},${h.p[1]}`;
    if (said.has(key)) continue;
    said.add(key);
    const d = h.alongM ?? haversine(me, h.p);
    const what = cat === 'fuel' ? 'Petrol pump' : cat === 'restaurant' ? 'Restaurant' : 'Mechanic';
    say(`${what} in ${d >= 950 ? (d / 1000).toFixed(1) + ' kilometres' : Math.round(d / 50) * 50 + ' metres'}${h.name && !/^(Fuel station|Restaurant|Mechanic)$/.test(h.name) ? ', ' + h.name : ''}`);
    return;
  }
}
