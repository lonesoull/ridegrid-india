import { useEffect, useState } from 'react';
import { engine } from '../core/engine';
import { fmtKm, haversine, type LngLat } from '../core/geo';
import { nav } from '../nav/navigator';
import { directionsTo, myLocation, rideMinutes, type Directions } from '../nav/directions';
import { ui, useUI, act, toast } from './state';
import { useEngine } from './hooks';
import { useNav } from './navHooks';
import { mapCtl } from './App';

const gmapsTo = (lat: number, lng: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}&travelmode=two-wheeler`;

/** Google-Maps-style card for the selected stop: directions, start, simulate and edit actions. */
export function StopSheet() {
  useEngine(); useNav();
  const id = useUI((s) => s.selectedId);
  const insertAt = useUI((s) => s.insertAt);
  const [name, setName] = useState('');
  const [dir, setDir] = useState<Directions | null>(null);
  const [more, setMore] = useState(false);
  const i = id ? engine.indexOf(id) : -1;
  const s = engine.stops[i];
  useEffect(() => setName(s?.name ?? ''), [id, s?.name]);
  useEffect(() => { setDir(null); mapCtl?.setApproach(null); }, [id]);
  if (insertAt !== null && nav.mode === 'off') {
    return (
      <div className="sheet glass">
        <b>Tap the map to insert a stop at position #{insertAt + 1}</b>
        <button onClick={() => ui.set({ insertAt: null })}>Cancel</button>
      </div>
    );
  }
  if (!s || nav.mode !== 'off') return null;

  const N = engine.stops.length;
  const prev = engine.legAt(i - 1), next = engine.legAt(i);
  const legKm = (l: typeof prev) => (l ? (l.status === 'ok' ? fmtKm(l.distM) : `~${fmtKm(haversine(l.from, l.to) * 1.3)}`) : '—');
  const target: LngLat = [s.lng, s.lat];

  const getDirections = () => act('Finding road route from your location…', async () => {
    const d = await directionsTo(i);
    setDir(d);
    mapCtl?.setApproach(d.coords, true);
    mapCtl?.showMe(d.from, false);
    if (!d.routed) toast('Routing server unreachable — showing straight line', 'error');
  });

  /** Start (live or sim) from my location → this stop → rest of the planned route. */
  const start = (mode: 'live' | 'sim') => act(mode === 'live' ? 'Starting navigation…' : 'Starting simulation…', async () => {
    let approach: LngLat[] | null = dir?.coords ?? null;
    if (!approach) {
      try {
        const me = await myLocation();
        if (haversine(me, target) > 150) { const d = await directionsTo(i, me); approach = d.coords; mapCtl?.setApproach(d.coords); }
      } catch (e: any) {
        if (mode === 'live') throw e;               // live needs GPS
        toast('No location — simulating from this stop'); // sim can start at the stop
      }
    }
    if (!approach && N < 2) throw new Error('You are already at this stop and there is no next stop yet.');
    await nav.start(mode, i, approach);
    ui.set({ drawer: false, tapMode: 'off', selectedId: null, following: true });
    mapCtl?.startFollow(nav.pos);
  });

  return (
    <div className="sheet glass">
      <div className="sheet-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>Stop #{(i + 1).toLocaleString('en-IN')}</b>{s.name ? <span> · {s.name}</span> : null}
          <div className="muted mono">{s.lat.toFixed(6)}, {s.lng.toFixed(6)}</div>
        </div>
        <button className="x" onClick={() => ui.set({ selectedId: null })}>✕</button>
      </div>

      <div className="chips">
        {dir && <span className="chip accent">🧭 From you: <b>{fmtKm(dir.distM)}</b> · ~{rideMinutes(dir.distM)} min{dir.routed ? '' : ' (straight)'}</span>}
        {i > 0 && <span className="chip">From #{i}: <b>{legKm(prev)}</b></span>}
        {i < N - 1 && <span className="chip">To #{i + 2}: <b>{legKm(next)}</b></span>}
        {i > 0 && <span className="chip">At <b>{fmtKm(engine.kmMark(i))}</b> of route</span>}
        {i === 0 && <span className="chip">Start of route</span>}
      </div>

      <div className="btns main-actions">
        <button className={dir ? '' : 'primary'} onClick={getDirections}>🧭 Directions</button>
        <button className={dir ? 'primary' : ''} onClick={() => start('live')}>▶ Start</button>
        <button onClick={() => start('sim')}>⏵ Simulate</button>
      </div>
      <p className="hint">{i < N - 1 ? `Start = ride from where you are to this stop, then continue the planned route #${i + 1} → #${N}.` : 'Start = ride from where you are to this stop.'}</p>

      <div className="btns sm">
        {i > 0 && <button onClick={() => mapCtl?.flyToStop(i - 1)}>◀ #{i}</button>}
        {i < N - 1 && <button onClick={() => mapCtl?.flyToStop(i + 1)}>#{i + 2} ▶</button>}
        <button onClick={() => window.open(gmapsTo(s.lat, s.lng), '_blank', 'noopener')}>Google Maps</button>
        <button onClick={() => setMore(!more)}>{more ? 'Less ▴' : 'More ▾'}</button>
      </div>

      {more && <>
        <div className="btns sm">
          <button onClick={() => { ui.set({ insertAt: i, selectedId: null }); toast(`Tap the map to insert a stop before #${i + 1}`); }}>＋ Insert before</button>
          <button onClick={() => { ui.set({ insertAt: i + 1, selectedId: null }); toast(`Tap the map to insert a stop after #${i + 1}`); }}>＋ Insert after</button>
          <button onClick={() => navigator.clipboard?.writeText(`${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}`).then(() => toast('Coordinates copied'))}>Copy coords</button>
          <button className="danger" onClick={() => { ui.set({ selectedId: null }); void act(null, () => engine.deleteStop(s.id)); }}>Delete</button>
        </div>
        <input value={name} placeholder="Name this stop (optional)" onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== (s.name ?? '') && act(null, () => engine.renameStop(s.id, name))} />
        <div className="hint">Drag the highlighted stop on the map to move it — only the two legs next to it are recalculated.</div>
      </>}
    </div>
  );
}
