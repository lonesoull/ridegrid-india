import { useEffect, useRef, useState } from 'react';
import { searchPlaces, searchStatus, type Place } from '../core/search';
import { google } from '../core/google';
import { engine } from '../core/engine';
import { fmtKm } from '../core/geo';
import { mode } from '../core/mode';
import { ui, useUI } from './state';
import { mapCtl } from './App';
import { Icon } from './Icon';
import { searchCentre, warmLocation } from './SearchBar';
import { routePoints } from '../daily/DailySearchBar';
import { offlineSearch, history as searchHistory, remember, clearHistory } from '../daily/offlineSearch';
import { recentDestinations } from '../daily/extras';
import { parseCoords } from '../daily/coords';
import { FLAG_LABEL, hitFlags, type Hit } from '../daily/poiIndex';
import { openState } from '../daily/openingHours';
import { googleReady, googleTextNear, searchAlongRoute } from '../daily/gfeatures';

/**
 * Search, Google Maps style: a pill at the top with the settings button, a row of category chips,
 * and a results panel that opens under it. Google is used first whenever it can be (key + signal);
 * RideGrid's offline index only when there is no Google or no signal, or for filters Google doesn't have.
 * Tap outside, the back arrow, Escape or the phone's Back button closes it.
 */
const CATS: { id: string; label: string; icon: string; q: string }[] = [
  { id: 'fuel', label: 'Petrol', icon: 'fuel', q: 'petrol pump' },
  { id: 'restaurant', label: 'Food', icon: 'food', q: 'restaurant' },
  { id: 'mechanic', label: 'Mechanic', icon: 'wrench', q: 'two wheeler mechanic' },
  { id: 'atm', label: 'ATM', icon: 'cash', q: 'atm' },
  { id: 'hotel', label: 'Hotels', icon: 'bed', q: 'hotel' },
  { id: 'hospital', label: 'Hospital', icon: 'hospital', q: 'hospital' },
  { id: 'cafe', label: 'Tea & coffee', icon: 'coffee', q: 'tea stall' },
  { id: 'ev', label: 'EV charging', icon: 'zap', q: 'ev charging station' },
  { id: 'parking', label: 'Parking', icon: 'parking', q: 'parking' },
];
const EXP_CATS = [CATS[0], { id: 'police', label: 'Police', icon: 'shield', q: 'police station' }, CATS[4], CATS[5], CATS[2], CATS[1]];
const fmtDist = (m?: number) => (m === undefined ? '' : m < 1000 ? `${Math.round(m)} m` : fmtKm(m));
const ICON_FOR: Record<string, string> = { fuel: 'fuel', restaurant: 'food', fast_food: 'food', cafe: 'coffee', mechanic: 'wrench', tyres: 'wrench', moto_shop: 'wrench', atm: 'cash', bank: 'cash',
  hotel: 'bed', guest_house: 'bed', hostel: 'bed', hospital: 'hospital', clinic: 'hospital', pharmacy: 'hospital', ev: 'zap', parking: 'parking', police: 'shield' };

/** Icon for Google place types */
function iconForTypes(types?: string[]): string | undefined {
  const t = (types ?? []).join(' ');
  return /gas_station|fuel/.test(t) ? 'fuel' : /charging/.test(t) ? 'zap' : /restaurant|food|meal|bakery/.test(t) ? 'food' : /cafe|coffee|tea/.test(t) ? 'coffee'
    : /atm|bank/.test(t) ? 'cash' : /lodging|hotel|hostel|guest/.test(t) ? 'bed' : /hospital|doctor|pharmacy|clinic|health/.test(t) ? 'hospital'
      : /car_repair|motorcycle|repair/.test(t) ? 'wrench' : /parking/.test(t) ? 'parking' : /police/.test(t) ? 'shield' : undefined;
}

const hitToPlace = (h: Hit, i: number): Place & { icon?: string } => {
  const [hours, phone, , city] = h.info.split('|');
  const st = hours ? openState(hours) : null;
  const flags = hitFlags(h).map((f) => FLAG_LABEL[f] ?? f.replace('ev_', 'EV ')).join(' · ');
  return { id: `off:${i}:${h.p[0]},${h.p[1]}`, name: h.name, provider: 'osm', p: h.p, distM: h.distM, icon: ICON_FOR[h.cat],
    address: [h.label, st ? (st.open ? 'Open' : 'Closed') + ' · ' + st.text : '', phone, city, flags].filter(Boolean).join(' · ') };
};

export function SearchTop({ onSettings }: { onSettings: () => void }) {
  const results = useUI((s) => s.places) as (Place & { icon?: string })[];
  const daily = mode.current === 'daily';
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [cat, setCat] = useState<(typeof CATS)[number] | null>(null);
  const [along, setAlong] = useState(false);
  const [filters, setFilters] = useState<string[]>([]);
  const [, setTick] = useState(0);
  const [source, setSource] = useState<'google' | 'offline' | 'osm' | ''>('');
  const ctl = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const hasRoute = engine.legs.size > 0;

  // the phone's Back button closes the search instead of leaving the app
  useEffect(() => {
    if (!open) return;
    window.history.pushState({ rgSearch: 1 }, '');
    const onPop = () => close(false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open]);

  const show = (list: Place[], src: typeof source) => { ui.set({ places: list }); mapCtl?.setPlaces(list, null); setSource(src); };

  /** list = a full list of places (Enter, or a suggestion like "petrol pump near me"); otherwise suggestions as you type */
  const run = (text: string, c: typeof cat, o: { along: boolean; filters: string[] }, immediate = false, asList = false) => {
    ctl.current?.abort();
    if (!c && text.trim().length < 2) { show([], ''); setErr(''); setBusy(false); return; }
    const ac = new AbortController(); ctl.current = ac;
    setTimeout(async () => {
      if (ac.signal.aborted) return;
      setBusy(true); setErr('');
      try {
        const centre = searchCentre();
        const xy = c ? null : parseCoords(text);
        if (xy) { show([{ id: `xy:${xy}`, name: `${xy[1].toFixed(6)}, ${xy[0].toFixed(6)}`, address: 'Coordinates', p: xy, provider: 'osm' }], 'offline'); return; }
        const rp = o.along && daily ? routePoints() : null;
        const openNow = o.filters.includes('open');
        const offlineOnly = o.filters.some((f) => f !== 'open'); // veg / CNG / EV sockets: only OpenStreetMap knows these
        // 1) Google first
        if (googleReady() && !offlineOnly) {
          try {
            const wantList = asList;
            let list: Place[];
            if (rp) list = (await searchAlongRoute(c?.q ?? text, rp.pts)).map((g) => ({ id: `g:${g.id}`, name: g.name, address: [g.type, g.address].filter(Boolean).join(' · '), p: g.p, provider: 'google' }));
            else if (c || openNow || wantList) list = (await googleTextNear(c?.q ?? text, centre, { openNow, byDistance: !!c })).map((g) => ({ id: `g:${g.id}`, name: g.name, address: [g.type, g.address].filter(Boolean).join(' · '), p: g.p, provider: 'google', distM: g.distM, icon: c?.icon ?? iconForTypes([g.gtype ?? '']) } as Place));
            else list = (await searchPlaces(text, centre, ac.signal)).map((x) => ({ ...x, icon: x.kind === 'query' ? 'search' : iconForTypes(x.types) } as Place));
            if (!ac.signal.aborted) show(list, 'google');
            return;
          } catch (e: any) { if (e?.name === 'AbortError') return; searchStatus.googleError = e?.message ?? 'Google search failed'; /* offline below */ }
        }
        // 2) offline index (no Google / no signal / special filters)
        let hits = daily ? await offlineSearch.search(c ? '' : text, { near: centre, cat: c?.id, limit: o.filters.length ? 300 : 25, along: rp ? { pts: rp.pts, maxM: 2000, fromS: rp.fromS } : undefined }) : [];
        if (openNow) hits = hits.filter((h) => { const oh = h.info.split('|')[0]; return oh && openState(oh)?.open; });
        const fl = o.filters.filter((f) => f !== 'open');
        if (fl.length) hits = hits.filter((h) => { const f = hitFlags(h); return fl.every((x) => f.includes(x) || (x === 'veg' && f.includes('pureveg')) || (x === 'ev_any' && f.some((y) => y.startsWith('ev_')))); });
        if (hits.length) { if (!ac.signal.aborted) show(hits.slice(0, 25).map(hitToPlace), 'offline'); return; }
        // 3) free OpenStreetMap search online
        if (navigator.onLine && !fl.length) { const list = await searchPlaces(c?.q ?? text, centre, ac.signal); if (!ac.signal.aborted) show(list, 'osm'); return; }
        show([], 'offline');
        if (!navigator.onLine && !offlineSearch.loaded.size) setErr('No signal. Download search data for your region (Settings → Offline maps) to search offline.');
      } catch (e: any) { if (e?.name !== 'AbortError') setErr(e?.message ?? 'Search failed'); }
      finally { if (!ac.signal.aborted) setBusy(false); }
    }, immediate ? 0 : 250);
  };
  useEffect(() => () => ctl.current?.abort(), []);

  const opts = (p: Partial<{ along: boolean; filters: string[] }> = {}) => ({ along: p.along ?? along, filters: p.filters ?? filters });
  const openSearch = () => { setOpen(true); void warmLocation(); };
  const close = (popHistory = true) => {
    setOpen(false); input.current?.blur();
    if (popHistory && window.history.state?.rgSearch) window.history.back();
  };
  const pickCat = (c: (typeof CATS)[number]) => { setCat(c); setQ(''); setOpen(true); run('', c, opts(), true); };
  const clear = () => { setQ(''); setCat(null); setFilters([]); setErr(''); show([], ''); mapCtl?.setPlaces([], null); input.current?.focus(); };
  const pick = (p: Place) => {
    // a search suggestion ("petrol pump near me"): show the list of places, like Google Maps
    if (p.kind === 'query') { setQ(p.name); setCat(null); run(p.name, null, opts(), true, true); return; }
    if (p.p) remember({ name: p.name, address: p.address, p: p.p });
    ui.set({ place: p, selectedId: null }); close();
  };
  const toggleFilter = (f: string) => { const n = filters.includes(f) ? filters.filter((x) => x !== f) : [...filters, f]; setFilters(n); run(q, cat, opts({ filters: n }), true); };

  const recents = daily ? [...recentDestinations().map((d) => ({ name: d.name, address: '', p: d.p, at: d.at })), ...searchHistory()].filter((h, i, a) => a.findIndex((x) => x.name === h.name) === i).slice(0, 6) : [];
  const cats = daily ? CATS : EXP_CATS;
  const showList = q.trim().length >= 2 || !!cat;

  return (
    <>
      {open && <div className="search-scrim" onClick={() => close()} />}
      <div className={`topbar ${open ? 'open' : ''}`}>
        <div className="searchpill">
          <button className="iconbtn" aria-label={open ? 'Back' : 'Search'} onClick={() => (open ? close() : (input.current?.focus(), openSearch()))}>
            <Icon name={open ? 'back' : 'search'} size={22} />
          </button>
          {cat && !q ? (
            <button className="catpill" onClick={clear}><Icon name={cat.icon} size={16} /> {cat.label} <Icon name="close" size={14} /></button>
          ) : (
            <input ref={input} value={q} enterKeyHint="search" placeholder={daily ? 'Search here' : 'Search police, hotel, fuel…'}
              onFocus={openSearch}
              onChange={(e) => { setQ(e.target.value); setCat(null); run(e.target.value, null, opts()); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { run(q, cat, opts(), true, true); input.current?.blur(); } if (e.key === 'Escape') close(); }} />
          )}
          {(q || cat) && <button className="iconbtn" aria-label="Clear" onClick={clear}><Icon name="close" size={20} /></button>}
          <button className="iconbtn avatar" aria-label="Settings" onClick={() => { close(); onSettings(); }}><Icon name="settings" size={22} /></button>
        </div>
        {!open && (
          <div className="catrow" role="toolbar" aria-label="Categories">
            {cats.map((c) => <button key={c.id} className="catchip" onClick={() => pickCat(c)}><Icon name={c.icon} size={18} />{c.label}</button>)}
          </div>
        )}
      </div>
      {open && (
        <div className="search-panel" role="listbox">
          {showList && (
            <div className="filterrow">
              {daily && hasRoute && <button className={`fchip ${along ? 'on' : ''}`} onClick={() => { setAlong(!along); run(q, cat, opts({ along: !along }), true); }}><Icon name="route" size={16} />Along my route</button>}
              <button className={`fchip ${filters.includes('open') ? 'on' : ''}`} onClick={() => toggleFilter('open')}>Open now</button>
              {daily && (cat?.id === 'restaurant' || cat?.id === 'cafe' || (!cat && q)) && <button className={`fchip ${filters.includes('veg') ? 'on' : ''}`} onClick={() => toggleFilter('veg')}>Veg</button>}
              {daily && (cat?.id === 'fuel' || cat?.id === 'ev') && <button className={`fchip ${filters.includes(cat.id === 'ev' ? 'ev_any' : 'cng') ? 'on' : ''}`} onClick={() => toggleFilter(cat.id === 'ev' ? 'ev_any' : 'cng')}>{cat.id === 'ev' ? 'Has socket info' : 'CNG'}</button>}
              {daily && <button className={`fchip ${filters.includes('24h') ? 'on' : ''}`} onClick={() => toggleFilter('24h')}>24 hours</button>}
            </div>
          )}
          {busy && <div className="sp-status"><span className="spin" /> Searching…</div>}
          {err && <div className="sp-status warn">{err}</div>}
          {showList && results.map((p) => (
            <button key={p.id} className="resrow" onClick={() => pick(p)}>
              <span className="resicon"><Icon name={p.icon ?? cat?.icon ?? 'pin'} size={20} /></span>
              <span className="restext"><span className="restitle">{p.name}</span><span className="ressub">{p.address}</span></span>
              {p.distM !== undefined && <span className="resdist">{fmtDist(p.distM)}</span>}
            </button>
          ))}
          {showList && !busy && !err && !results.length && <div className="sp-status">No results</div>}
          {!showList && (
            <>
              {recents.length > 0 && <div className="sp-head">Recent <button className="textbtn" onClick={() => { clearHistory(); setTick((n) => n + 1); }}>Clear</button></div>}
              {recents.map((h) => (
                <button key={h.name + h.at} className="resrow" onClick={() => pick({ id: `h:${h.at}`, name: h.name, address: h.address, p: h.p, provider: 'osm' })}>
                  <span className="resicon"><Icon name="clock" size={20} /></span>
                  <span className="restext"><span className="restitle">{h.name}</span>{h.address && <span className="ressub">{h.address}</span>}</span>
                </button>
              ))}
              {!recents.length && <div className="sp-status muted">Search for a place, an address, a PIN code or coordinates.</div>}
            </>
          )}
          {showList && source !== 'google' && searchStatus.googleError && google.settings.key && <div className="sp-status warn">Google search isn't working: {searchStatus.googleError}. Check that “Places API (New)” is enabled for your key (Settings → Google Maps → Test key).</div>}
          {showList && results.length > 0 && <div className="sp-foot">{source === 'google' ? 'Results from Google' : source === 'offline' ? 'Offline results (OpenStreetMap)' : 'Results from OpenStreetMap'}{!google.active && source !== 'offline' ? ' · add a Google key in Settings for Google search' : ''}</div>}
        </div>
      )}
    </>
  );
}

