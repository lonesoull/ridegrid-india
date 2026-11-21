import { useEffect, useState } from 'react';
import { resolvePlace, type Place } from '../core/search';
import { engine } from '../core/engine';
import { fmtKm, haversine, type LngLat } from '../core/geo';
import { isExpedition, T } from '../core/terms';
import { nav } from '../nav/navigator';
import { directionsToPoint, fixProblem, myFix, rideMinutes, type Directions } from '../nav/directions';
import { TransitPanel } from '../daily/TransitPanel';
import { GooglePlaceExtras } from '../daily/GooglePlaceExtras';
import { rememberDestination } from '../daily/extras';
import { buildRouteLine, matchToRoute, type RouteLine } from '../nav/routeLine';
import { SegIndex } from '../nav/spatial';
import { safeRoute, type SafeRoute } from '../nav/detour';
import { ui, useUI, act, toast } from './state';
import { useNav } from './navHooks';
import { startRide } from './startRide';
import { knownLocation } from './SearchBar';
import { mapCtl } from './App';
import { Icon } from './Icon';

const fmtMin = (s?: number) => { if (!s) return '—'; const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.max(1, m)} min`; };
/** label on a grey alternative: how much slower than the chosen route */
const altLabel = (c: Directions, sel: Directions) => { const d = Math.round(((c.durS ?? 0) - (sel.durS ?? 0)) / 60); return d === 0 ? fmtMin(c.durS) : d > 0 ? `+${d} min` : `${d} min`; };

let planned: { v: number; L: RouteLine; idx: SegIndex } | null = null;
function plannedIndex() {
  if (!planned || planned.v !== engine.version) { const L = buildRouteLine(); planned = { v: engine.version, L, idx: new SegIndex(L) }; }
  return planned;
}

/** Card for a searched place: directions / go / add stop (daily) or a Guinness safety check (expedition). */
export function PlaceCard() {
  useNav();
  const sel = useUI((s) => s.place);
  const [pl, setPl] = useState<Place | null>(null);
  const [dir, setDir] = useState<Directions | null>(null);
  const [safe, setSafe] = useState<SafeRoute | null>(null);
  const exp = isExpedition();

  useEffect(() => {
    setDir(null); setSafe(null); setPl(null);
    if (!sel) return;
    let live = true;
    void resolvePlace(sel).then((r) => {
      if (!live) return;
      setPl(r);
      mapCtl?.setPlaces(ui.get().places.map((x) => (x.id === r.id ? r : x)), r.id, false);
      mapCtl?.map.flyTo({ center: r.p!, zoom: Math.max(mapCtl.map.getZoom(), 15), duration: 600 });
    }).catch((e) => toast(e.message, 'error'));
    return () => { live = false; };
  }, [sel?.id]);

  if (!sel || nav.mode !== 'off') return null;
  const close = () => { ui.set({ place: null, places: [] }); mapCtl?.setApproach(null); mapCtl?.setAlternatives(null); mapCtl?.setPlaces([], null); };
  const p = pl?.p;
  // distance from the rider (or from where the search was made) — not from the map centre, which moves to the place
  const here = knownLocation();
  const straight = p && here ? haversine(here, p) : undefined;

  /** Rider position checked for VPN / Wi-Fi nonsense. */
  const where = async (): Promise<LngLat> => {
    if (nav.pos) return nav.pos;
    const f = await myFix();
    const prob = fixProblem(f, p);
    if (prob) throw new Error(prob);
    return f.p;
  };

  /** show route choice k (blue) and the others grey with their extra time, like Google Maps */
  const choose = (d: Directions, k: number) => {
    const all = d.choices ?? [d];
    const pick = all[k] ?? all[0];
    setDir({ ...pick, choices: all });
    mapCtl?.setApproach(pick.coords, k === 0 && !dir);
    mapCtl?.setAlternatives(all.map((c, i) => ({ c, i })).filter((x) => x.i !== k).map(({ c, i }) => ({ i, coords: c.coords, label: altLabel(c, pick) })));
    if (mapCtl) mapCtl.onAltPick = (i) => choose({ ...pick, choices: all }, i);
  };
  const directions = () => act('Finding a road route…', async () => choose(await directionsToPoint(p!, await where()), 0));

  const addStop = async (): Promise<number> => {
    await engine.addStop(p!, engine.stops.length, pl!.name);
    if (!exp) rememberDestination(pl!.name, p!);
    return engine.stops.length - 1;
  };

  const go = (mode: 'live' | 'sim') => act(mode === 'live' ? 'Starting navigation…' : 'Starting simulation…', async () => {
    const i = await addStop();
    ui.set({ place: null });
    mapCtl?.setAlternatives(null);
    await startRide(mode, i, dir ? { coords: dir.coords, turns: dir.turns } : null);
  });

  /** Expedition: can this place be reached (and left) without coming within the gap of any other planned road? */
  const safetyCheck = () => act('Checking against your planned roads…', async () => {
    const { L, idx } = plannedIndex();
    if (L.n < 2) throw new Error('Plan your expedition route first');
    const me = await where();
    const m = matchToRoute(L, me, 0, 0);
    const depS = nav.detour?.depS ?? m.s;
    const skip: [number, number] = [depS - 150, depS + 150];
    const r = await safeRoute(me, p!, L, idx, skip, nav.settings.gapM);
    setSafe(r);
    mapCtl?.setApproach(r.coords, true);
  });

  return (
    <div className="sheet glass">
      <div className="sheet-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{(pl ?? sel).name}</b>
          <div className="muted">{sel.address.length > (pl?.address.length ?? 0) ? sel.address : (pl ?? sel).address}</div>
        </div>
        <button className="x" aria-label="Close" onClick={close}><Icon name="close" size={18} /></button>
      </div>
      {!p ? <div className="muted">Loading place…</div> : <>
        <div className="chips">
          {straight !== undefined && <span className="chip">{fmtKm(straight)} away</span>}
          {dir && <span className="chip accent">By road <b>{fmtKm(dir.distM)}</b> · {dir.durS ? `${Math.max(1, Math.round(dir.durS / 60))} min with live traffic` : `~${rideMinutes(dir.distM)} min`}</span>}
          {safe && <span className={`chip ${safe.ok ? 'okchip' : 'badchip'}`}>{safe.ok ? `✅ Keeps ≥ ${nav.settings.gapM} m from other planned roads` : `⚠ Passes ${Math.round(safe.minGapM)} m from a planned road`} · {fmtKm(safe.distM)}</span>}
        </div>
        {exp ? <>
          <div className="actionrow">
            <button className="primary" onClick={safetyCheck}><Icon name="shield" size={18} /> Safety check</button>
            <button onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${p[1]},${p[0]}&travelmode=two-wheeler`, '_blank', 'noopener')}><Icon name="gmaps" size={18} /> Google Maps</button>
          </div>
          <p className="hint">Expedition: checks a way from where you are to this place that keeps {nav.settings.gapM} m from every other planned road (crossings, sub-roads, flyovers, parallel roads). While you go there, Detour mode guards you, and “Return the way I came” brings you back.</p>
        </> : <>
          {dir?.choices && dir.choices.length > 1 && (
            <div className="routechoices">
              {dir.choices.map((c, k) => {
                const on = c.coords === dir.coords;
                const fastest = k === 0;
                return (
                  <button key={k} className={`routechoice ${on ? 'on' : ''}`} onClick={() => choose(dir, k)}>
                    <b className={fastest ? 'fast' : ''}>{fmtMin(c.durS)}</b>
                    <span>{fmtKm(c.distM)}{c.description ? ` · ${c.description}` : ''}</span>
                    <small>{fastest ? 'Fastest · live traffic' : `+${Math.max(1, Math.round(((c.durS ?? 0) - (dir.choices![0].durS ?? 0)) / 60))} min`}</small>
                  </button>
                );
              })}
            </div>
          )}
          <div className="actionrow">
            <button className={dir ? '' : 'primary'} onClick={directions}><Icon name="directions" size={18} /> Directions</button>
            <button className={dir ? 'primary' : ''} onClick={() => go('live')}><Icon name="play" size={18} /> Start</button>
            <button onClick={() => act(null, async () => { const i = await addStop(); toast(`Added as ${T().one} #${i + 1}`); })}><Icon name="plus" size={18} /> Add stop</button>
            <button onClick={() => go('sim')}><Icon name="sim" size={18} /> Simulate</button>
          </div>
          <TransitPanel from={async () => nav.pos ?? (await myFix()).p} to={p} />
          <GooglePlaceExtras p={p} placeId={(pl ?? sel).id.startsWith('g:') ? (pl ?? sel).id.slice(2) : undefined} name={sel.name} from={where} />
        </>}
      </>}
    </div>
  );
}
