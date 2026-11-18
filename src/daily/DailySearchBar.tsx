import { useEffect, useRef, useState } from 'react';
import { searchPlaces, type Place } from '../core/search';
import { fmtKm, type LngLat } from '../core/geo';
import { nav } from '../nav/navigator';
import { buildRouteLine } from '../nav/routeLine';
import { engine } from '../core/engine';
import { ui, useUI } from '../ui/state';
import { mapCtl } from '../ui/App';
import { searchCentre, knownLocation, warmLocation } from '../ui/SearchBar';
import { offlineSearch, history, remember, clearHistory, type HistItem } from './offlineSearch';
import { parseCoords } from './coords';
import { CAT_LABEL, type Hit } from './poiIndex';

const fmtDist = (m?: number) => (m === undefined ? '' : m < 1000 ? `${Math.round(m)} m` : fmtKm(m));
const CHIPS = ['fuel', 'restaurant', 'mechanic', 'tyres', 'atm', 'hospital', 'pharmacy', 'hotel', 'police', 'toilets', 'parking', 'cafe', 'ev'];

const toPlace = (h: Hit, i: number): Place => ({
  id: `off:${i}:${h.p[0]},${h.p[1]}`, name: h.name, provider: 'osm', p: h.p, distM: h.distM,
  address: [h.label, h.info.split('|')[0] && `🕒 ${h.info.split('|')[0]}`, h.info.split('|')[1] && `☎ ${h.info.split('|')[1]}`, h.info.split('|')[3]].filter(Boolean).join(' · '),
});

/** Route ahead as sampled points (for "along my route"). */
function routePoints(): { pts: LngLat[]; fromS?: number } | null {
  if (!engine.legs.size) return null;
  const L = buildRouteLine();
  if (L.n < 2) return null;
  const step = Math.max(1, Math.floor(L.n / 20000));
  const pts: LngLat[] = [];
  for (let i = 0; i < L.n; i += step) pts.push([L.x[i], L.y[i]]);
  return { pts, fromS: nav.mode !== 'off' ? nav.s : undefined };
}

/**
 * Daily ride "Where to?" (OsmAnd search): offline places, streets & towns (no internet needed),
 * categories, along-my-route, coordinates / plus codes / UTM, history and a nearby card;
 * online Google / OpenStreetMap results are added when there is internet.
 */
export function DailySearchBar() {
  const results = useUI((s) => s.places);
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [along, setAlong] = useState(false);
  const [near, setNear] = useState<{ cat: string; label: string; hits: Hit[] }[]>([]);
  const [hist, setHist] = useState<HistItem[]>(history());
  const ctl = useRef<AbortController | null>(null);
  const meta = useRef(new Map<string, Hit>());

  useEffect(() => {
    if (!focus || q) return;
    setHist(history());
    void offlineSearch.nearby(searchCentre()).then(setNear).catch(() => setNear([]));
  }, [focus, q]);

  const run = (text: string, cat?: string, immediate = false) => {
    ctl.current?.abort();
    if (!cat && text.trim().length < 2) { ui.set({ places: [] }); setErr(''); return; }
    const c = new AbortController();
    ctl.current = c;
    setTimeout(async () => {
      if (c.signal.aborted) return;
      setBusy(true); setErr('');
      try {
        const out: Place[] = [];
        const xy = cat ? null : parseCoords(text);
        if (xy) out.push({ id: `xy:${xy}`, name: `${xy[1].toFixed(6)}, ${xy[0].toFixed(6)}`, address: 'Coordinates', p: xy, provider: 'osm' });
        const centre = searchCentre();
        const rp = along ? routePoints() : null;
        const hits = await offlineSearch.search(cat ? '' : text, { near: centre, cat, limit: 25, along: rp ? { pts: rp.pts, maxM: 2000, fromS: rp.fromS } : undefined });
        meta.current.clear();
        hits.forEach((h, i) => { const p = toPlace(h, i); if (rp && h.alongM !== undefined) p.address = `${fmtDist(h.alongM - (rp.fromS ?? 0))} ahead · ${fmtDist(h.offM)} off route · ${p.address}`; meta.current.set(p.id, h); out.push(p); });
        // online results when there is internet (and not restricted to the route)
        if (!along && navigator.onLine && !xy) {
          try {
            const online = await searchPlaces(cat ? (CAT_LABEL[cat] ?? cat) : text, centre, c.signal);
            for (const o of online) if (!out.some((x) => x.name.toLowerCase() === o.name.toLowerCase() && (!x.p || !o.p || Math.abs(x.p[0] - o.p[0]) < 0.002))) out.push(o);
          } catch (e: any) { if (e?.name === 'AbortError') throw e; if (!out.length) setErr(e?.message ?? 'Online search failed'); }
        }
        if (!c.signal.aborted) { ui.set({ places: out }); mapCtl?.setPlaces(out, null); }
        if (!out.length && !offlineSearch.loaded.size && !navigator.onLine) setErr('Offline: download search data for this region in Map → Offline maps');
      } catch (e: any) { if (e?.name !== 'AbortError') setErr(e?.message ?? 'Search failed'); }
      finally { if (!c.signal.aborted) setBusy(false); }
    }, immediate ? 0 : 300);
  };
  useEffect(() => () => ctl.current?.abort(), []);

  const pick = (p: Place) => {
    if (p.p) remember({ name: p.name, address: p.address, p: p.p });
    ui.set({ place: p, selectedId: null }); setFocus(false);
  };
  const pickHit = (h: Hit) => pick(toPlace(h, 0));
  const clear = () => { setQ(''); ui.set({ places: [], place: null }); mapCtl?.setPlaces([], null); };
  const me = knownLocation();

  return (
    <div className="search" onClick={(e) => e.stopPropagation()}>
      <div className="searchrow">
        <input value={q} placeholder="Where to? Place, street, town, 12.97,77.59, plus code…" onFocus={() => { setFocus(true); void warmLocation(); }}
          onChange={(e) => { setQ(e.target.value); run(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') run(q, undefined, true); if (e.key === 'Escape') { clear(); setFocus(false); } }} />
        {(q || results.length > 0) && <button className="x" aria-label="Clear search" onClick={clear}>✕</button>}
      </div>
      {focus && (
        <div className="searchdrop glass">
          <div className="chips">
            {engine.legs.size > 0 && <button className={`chip ${along ? 'on' : ''}`} onClick={() => { setAlong(!along); }}>🛣 Along my route</button>}
            {CHIPS.map((c) => <button key={c} className="chip" onClick={() => { setQ(CAT_LABEL[c]); run('', c, true); }}>{CAT_LABEL[c]}</button>)}
          </div>
          {busy && <div className="muted">Searching…</div>}
          {err && <div className="warn">{err}</div>}
          {results.map((p) => (
            <button key={p.id} className="link result" onClick={() => pick(p)}>
              <b>{p.name}</b>{p.distM !== undefined && <span className="muted"> · {fmtDist(p.distM)}</span>}
              {p.id.startsWith('off:') && <span className="pill">offline</span>}
              <div className="muted">{p.address}</div>
            </button>
          ))}
          {!q && hist.length > 0 && <>
            <div className="dsec">Recent <button className="link muted" onClick={() => { clearHistory(); setHist([]); }}>clear</button></div>
            {hist.slice(0, 8).map((h) => (
              <button key={h.name + h.at} className="link result" onClick={() => pick({ id: `h:${h.at}`, name: h.name, address: h.address, p: h.p, provider: 'osm' })}>
                🕘 <b>{h.name}</b><div className="muted">{h.address}</div>
              </button>
            ))}
          </>}
          {!q && near.length > 0 && <>
            <div className="dsec">Nearby{me ? '' : ' (map centre)'}</div>
            {near.map((g) => (
              <div key={g.cat} className="nearcat"><span className="muted">{g.label}</span>
                {g.hits.map((h, i) => <button key={i} className="link" onClick={() => pickHit(h)}>{h.name} <span className="muted">{fmtDist(h.distM)}</span></button>)}
              </div>
            ))}
          </>}
          {!busy && q.trim().length >= 2 && !results.length && !err && <div className="muted">No results</div>}
          {!offlineSearch.loaded.size && <div className="muted small-note">Tip: download search data in Map → Offline maps to search with no internet.</div>}
          <button className="link muted closer" onClick={() => setFocus(false)}>Close</button>
        </div>
      )}
    </div>
  );
}
