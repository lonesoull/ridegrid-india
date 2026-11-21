import { useState } from 'react';
import { engine } from '../core/engine';
import { fmtKm, haversine, type LngLat } from '../core/geo';
import { nav } from '../nav/navigator';
import { mapCtl } from '../ui/App';
import { ui } from '../ui/state';
import { routePoints } from './DailySearchBar';
import { offlineSearch, alertData } from './offlineSearch';
import { CAT_LABEL } from './poiIndex';
import { markers } from './markers';
import { googleReady, searchAlongRoute } from './gfeatures';
import { ALERT_ICON, type AlertKind } from './roadAlerts';

/** OsmAnd "Show along the route": fuel, food, mechanics, favourites, road alerts… in order ahead.
 *  Google search along the route when online (Google first), the offline index otherwise. */
const CATS = ['fuel', 'restaurant', 'mechanic', 'tyres', 'atm', 'hotel', 'hospital', 'toilets', 'ev', 'fav', 'alerts'] as const;
type Cat = (typeof CATS)[number];
const LABEL = (c: Cat) => (c === 'fav' ? '★ My favourites' : c === 'alerts' ? '⚠ Road alerts' : CAT_LABEL[c]);
interface Row { name: string; p: LngLat; ahead: number; off: number; src: string }

/** Nearest route point (distance along, distance off) using ~2 km grid cells, fast for long routes. */
function grid(pts: LngLat[]) {
  const C = 0.02, cells = new Map<number, number[]>(), cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  pts.forEach((p, i) => { const k = Math.floor(p[0] / C) * 100000 + Math.floor(p[1] / C); const a = cells.get(k); if (a) a.push(i); else cells.set(k, [i]); });
  return (p: LngLat): { s: number; d: number } => {
    const cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C);
    let best = { s: 0, d: Infinity };
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const i of cells.get((cx + dx) * 100000 + cy + dy) ?? []) {
      const d = haversine(pts[i], p); if (d < best.d) best = { s: cum[i], d };
    }
    return best;
  };
}

export function AlongRoute() {
  const [cat, setCat] = useState<Cat>('fuel');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  if (!engine.legs.size) return null;

  const run = async (c: Cat) => {
    setCat(c); setBusy(true); setMsg(''); setRows(null);
    try {
      const rp = routePoints();
      if (!rp) throw new Error('Plan a route first');
      const near = grid(rp.pts);
      const from = rp.fromS ?? 0, maxOff = c === 'alerts' ? 40 : 2000;
      let out: Row[] = [];
      if (c === 'fav') {
        out = markers.favourites().map((m) => { const a = near(m.p); return { name: m.name, p: m.p, ahead: a.s - from, off: a.d, src: 'favourite' }; });
      } else if (c === 'alerts') {
        for (const arr of alertData.values()) for (let i = 0; i < arr.length / 2; i++) {
          const p: LngLat = [arr[i * 2], arr[i * 2 + 1]];
          const k = (arr.kinds?.[i] ?? 'hazard') as AlertKind;
          if (k === 'signals' || k === 'zebra' || k === 'stop') continue;
          const a = near(p);
          if (a.d < maxOff) out.push({ name: `${ALERT_ICON[k] ?? '⚠'} ${k}`, p, ahead: a.s - from, off: a.d, src: 'offline' });
        }
      } else if (googleReady()) {
        try {
          const g = await searchAlongRoute(CAT_LABEL[c] ?? c, rp.pts);
          out = g.map((x) => { const a = near(x.p); return { name: x.name, p: x.p, ahead: a.s - from, off: a.d, src: 'Google' }; });
        } catch { /* offline below */ }
      }
      if (!out.length && c !== 'fav' && c !== 'alerts') {
        const hits = await offlineSearch.search('', { cat: c, limit: 60, along: { pts: rp.pts, maxM: maxOff, fromS: rp.fromS } });
        out = hits.map((h) => ({ name: h.name, p: h.p, ahead: (h.alongM ?? 0) - from, off: h.offM ?? 0, src: 'offline' }));
        if (!offlineSearch.loaded.size) setMsg('Offline: download search data in Settings → Map → Offline maps.');
      }
      out = out.filter((r) => r.ahead >= -200 && r.off <= maxOff).sort((a, b) => a.ahead - b.ahead).slice(0, 60);
      setRows(out);
    } catch (e: any) { setMsg(e?.message ?? 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <section>
      <h3>Along my route</h3>
      <div className="chips">{CATS.map((c) => <button key={c} className={`chip ${c === cat && rows ? 'on' : ''}`} onClick={() => void run(c)}>{LABEL(c)}</button>)}</div>
      {busy && <p className="muted">Looking along the route…</p>}
      {msg && <p className="muted">{msg}</p>}
      {rows && !rows.length && <p className="muted">Nothing found within 2 km of the route{nav.mode !== 'off' ? ' ahead' : ''}.</p>}
      {rows?.map((r, i) => (
        <button key={i} className="link result" onClick={() => { ui.set({ drawer: false }); mapCtl?.map.flyTo({ center: r.p, zoom: 16 }); }}>
          <b>{r.name}</b> <span className="muted">· {fmtKm(Math.max(0, r.ahead))} ahead · {Math.round(r.off)} m off route · {r.src}</span>
        </button>
      ))}
    </section>
  );
}
