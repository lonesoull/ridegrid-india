import { useEffect, useRef, useState } from 'react';
import { searchPlaces, CATEGORIES, type Place } from '../core/search';
import { google } from '../core/google';
import { fmtKm, type LngLat } from '../core/geo';
import { isExpedition } from '../core/terms';
import { nav } from '../nav/navigator';
import { ui, useUI } from './state';
import { mapCtl } from './App';
import { myFix, fixProblem } from '../nav/directions';

const fmtDist = (m?: number) => (m === undefined ? '' : m < 1000 ? `${Math.round(m)} m` : fmtKm(m));

let lastFix: LngLat | null = null;
/** Grab a trustworthy location once when search opens (rejects VPN / Wi-Fi guesses). */
async function warmLocation() {
  if (nav.pos || lastFix) return;
  try { const f = await myFix(); if (!fixProblem(f)) lastFix = f.p; } catch { /* no permission: use map centre */ }
}
/** Rider position or last good fix (null if unknown). */
export const knownLocation = (): LngLat | null => nav.pos ?? lastFix;
/** Where the search should be centred: rider position, else last good fix, else map centre. */
export function searchCentre(): LngLat {
  if (nav.pos) return nav.pos;
  if (lastFix) return lastFix;
  const c = mapCtl!.map.getCenter();
  return [c.lng, c.lat];
}

/** "Where to?" box + quick categories + results list. Selecting a result opens the place card. */
export function SearchBar() {
  const results = useUI((s) => s.places);
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ctl = useRef<AbortController | null>(null);
  const exp = isExpedition();

  const run = (text: string, immediate = false) => {
    ctl.current?.abort();
    if (text.trim().length < 2) { ui.set({ places: [] }); setErr(''); return; }
    const c = new AbortController();
    ctl.current = c;
    setTimeout(async () => {
      if (c.signal.aborted) return;
      setBusy(true); setErr('');
      try {
        const list = await searchPlaces(text, searchCentre(), c.signal);
        if (!c.signal.aborted) { ui.set({ places: list }); mapCtl?.setPlaces(list, null); }
      } catch (e: any) { if (e?.name !== 'AbortError') setErr(e?.message ?? 'Search failed'); }
      finally { if (!c.signal.aborted) setBusy(false); }
    }, immediate ? 0 : 350);
  };
  useEffect(() => () => ctl.current?.abort(), []);

  const pick = (p: Place) => { ui.set({ place: p, selectedId: null }); setFocus(false); };
  const clear = () => { setQ(''); ui.set({ places: [], place: null }); mapCtl?.setPlaces([], null); };
  const open = focus && (q.length > 0 || true);

  return (
    <div className="search" onClick={(e) => e.stopPropagation()}>
      <div className="searchrow">
        <input value={q} placeholder={exp ? 'Find police station, hotel, fuel…' : 'Where to?'} onFocus={() => { setFocus(true); void warmLocation(); }}
          onChange={(e) => { setQ(e.target.value); run(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') run(q, true); if (e.key === 'Escape') { clear(); setFocus(false); } }} />
        {(q || results.length > 0) && <button className="x" aria-label="Clear search" onClick={clear}>✕</button>}
      </div>
      {open && (
        <div className="searchdrop glass">
          <div className="chips">
            {CATEGORIES.map((c) => <button key={c.q} className="chip" onClick={() => { setQ(c.label); run(c.q, true); }}>{c.label}</button>)}
          </div>
          {busy && <div className="muted">Searching…</div>}
          {err && <div className="warn">{err}</div>}
          {results.map((p) => (
            <button key={p.id} className="link result" onClick={() => pick(p)}>
              <b>{p.name}</b>{p.distM !== undefined && <span className="muted"> · {fmtDist(p.distM)}</span>}
              <div className="muted">{p.address}</div>
            </button>
          ))}
          {!busy && q.trim().length >= 2 && !results.length && !err && <div className="muted">No results</div>}
          {results.length > 0 && <div className="muted small-note">{results[0].provider === 'google' ? 'Powered by Google' : 'Search © OpenStreetMap contributors (Photon)'}{!google.active && ' · add a Google key in Tools for Google search'}</div>}
          <button className="link muted closer" onClick={() => setFocus(false)}>Close</button>
        </div>
      )}
    </div>
  );
}
