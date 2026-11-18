import { useEffect, useState } from 'react';
import { T } from '../core/terms';
import { engine } from '../core/engine';
import { fmtKm, haversine } from '../core/geo';
import { nav } from '../nav/navigator';
import { directionsTo, rideMinutes, type Directions } from '../nav/directions';
import { startRide } from './startRide';
import { ui, useUI, act, toast } from './state';
import { useEngine } from './hooks';
import { useNav } from './navHooks';
import { mapCtl } from './App';
import { Icon } from './Icon';

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
  useEffect(() => { setDir(null); if (nav.mode === 'off') mapCtl?.setApproach(null); }, [id]);
  if (insertAt !== null && nav.mode === 'off') {
    return (
      <div className="sheet glass">
        <b>Tap the map to insert a {T().one} at position #{insertAt + 1}</b>
        <button onClick={() => ui.set({ insertAt: null })}>Cancel</button>
      </div>
    );
  }
  if (!s || nav.mode !== 'off') return null;

  const N = engine.stops.length;
  const prev = engine.legAt(i - 1), next = engine.legAt(i);
  const legKm = (l: typeof prev) => (l ? (l.status === 'ok' ? fmtKm(l.distM) : `~${fmtKm(haversine(l.from, l.to) * 1.3)}`) : '—');

  const getDirections = () => act('Finding road route from your location…', async () => {
    const d = await directionsTo(i);
    setDir(d);
    mapCtl?.setApproach(d.coords, true);
    mapCtl?.showMe(d.from, false);
    if (!d.routed) toast('Routing server unreachable — showing straight line', 'error');
  });

  const start = (mode: 'live' | 'sim') => act(mode === 'live' ? 'Starting navigation…' : 'Starting simulation…',
    () => startRide(mode, i, dir ? { coords: dir.coords, turns: dir.turns } : null));

  return (
    <div className="sheet glass">
      <div className="sheet-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{T().One} #{(i + 1).toLocaleString('en-IN')}</b>{s.name ? <span> · {s.name}</span> : null}
          <div className="muted mono">{s.lat.toFixed(6)}, {s.lng.toFixed(6)}</div>
        </div>
        <button className="x" aria-label="Close" onClick={() => ui.set({ selectedId: null })}><Icon name="close" size={18} /></button>
      </div>

      <div className="chips">
        {dir && <span className="chip accent">From you: <b>{fmtKm(dir.distM)}</b> · {dir.durS ? `${Math.max(1, Math.round(dir.durS / 60))} min with live traffic` : `~${rideMinutes(dir.distM)} min`}{dir.routed ? '' : ' (straight)'}</span>}
        {i > 0 && <span className="chip">From #{i}: <b>{legKm(prev)}</b></span>}
        {i < N - 1 && <span className="chip">To #{i + 2}: <b>{legKm(next)}</b></span>}
        {i > 0 && <span className="chip">At <b>{fmtKm(engine.kmMark(i))}</b> of route</span>}
        {i === 0 && <span className="chip">Start of route</span>}
      </div>

      <div className="btns main-actions">
        <button className={dir ? '' : 'primary'} onClick={getDirections}><Icon name="directions" /> Directions</button>
        <button className={dir ? 'primary' : ''} onClick={() => start('live')}><Icon name="play" /> Start</button>
        <button onClick={() => start('sim')}><Icon name="sim" /> Simulate</button>
      </div>
      <p className="hint">{i < N - 1 ? `Start = ride from where you are to this ${T().one}, then continue the planned route #${i + 1} → #${N}.` : `Start = ride from where you are to this ${T().one}.`}</p>

      <div className="btns sm">
        {i > 0 && <button onClick={() => mapCtl?.flyToStop(i - 1)}>◀ #{i}</button>}
        {i < N - 1 && <button onClick={() => mapCtl?.flyToStop(i + 1)}>#{i + 2} ▶</button>}
        <button onClick={() => window.open(gmapsTo(s.lat, s.lng), '_blank', 'noopener')}><Icon name="gmaps" size={18} /> Google Maps</button>
        <button onClick={() => setMore(!more)}>{more ? 'Less ▴' : 'More ▾'}</button>
      </div>

      {more && <>
        <div className="btns sm">
          <button onClick={() => { ui.set({ insertAt: i, selectedId: null }); toast(`Tap the map to insert a ${T().one} before #${i + 1}`); }}>＋ Insert before</button>
          <button onClick={() => { ui.set({ insertAt: i + 1, selectedId: null }); toast(`Tap the map to insert a ${T().one} after #${i + 1}`); }}>＋ Insert after</button>
          <button onClick={() => navigator.clipboard?.writeText(`${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}`).then(() => toast('Coordinates copied'))}>Copy coords</button>
          <button className="danger" onClick={() => { ui.set({ selectedId: null }); void act(null, () => engine.deleteStop(s.id)); }}>Delete</button>
        </div>
        <input value={name} placeholder={`Name this ${T().one} (optional)`} onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== (s.name ?? '') && act(null, () => engine.renameStop(s.id, name))} />
        <div className="hint">Drag the highlighted point on the map to move it — only the two legs next to it are recalculated.</div>
      </>}
    </div>
  );
}
