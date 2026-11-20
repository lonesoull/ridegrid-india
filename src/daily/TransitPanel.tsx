import { useState } from 'react';
import type { LngLat } from '../core/geo';
import { mapCtl } from '../ui/App';
import { act, ui } from '../ui/state';
import { showTrack } from './trackTools';
import { transitRoutes, MODE_ICON, type TransitRoute } from './transit';

/** Public transport options to a place (Daily place card). */
export function TransitPanel({ from, to }: { from: () => Promise<LngLat>; to: LngLat }) {
  const [routes, setRoutes] = useState<TransitRoute[] | null>(null);
  const [pick, setPick] = useState(0);
  const draw = (r: TransitRoute) => {
    if (!mapCtl) return;
    showTrack(mapCtl, { type: 'FeatureCollection', features: r.steps.filter((s) => s.coords.length > 1).map((s) => ({ type: 'Feature', properties: { c: s.mode === 'WALK' ? '#888' : s.color || '#1565c0' }, geometry: { type: 'LineString', coordinates: s.coords } })) });
    const all = r.steps.flatMap((s) => s.coords);
    if (all.length) mapCtl.map.fitBounds([[Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))], [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))]], { padding: 70 });
  };
  const load = () => act('Finding buses, metro and trains…', async () => { const r = await transitRoutes(await from(), to); setRoutes(r); setPick(0); draw(r[0]); });
  if (!routes) return <button onClick={load}>🚌 Public transport</button>;
  const r = routes[pick];
  return (
    <div className="transit">
      <div className="btns sm">{routes.map((x, i) => (
        <button key={i} className={i === pick ? 'on' : ''} onClick={() => { setPick(i); draw(x); }}>
          {Math.round(x.minutes)} min · {x.steps.filter((s) => s.mode !== 'WALK').map((s) => MODE_ICON[s.mode]).join('')}{x.transfers ? ` · ${x.transfers} change${x.transfers > 1 ? 's' : ''}` : ''}
        </button>))}</div>
      <ol className="tsteps">
        {r.steps.map((s, i) => (
          <li key={i}>{MODE_ICON[s.mode]} {s.mode === 'WALK' ? <>Walk {Math.round(s.minutes)} min</> : <>
            <b className="tline" style={{ background: s.color || '#1565c0' }}>{s.line ?? s.mode}</b> {s.headsign && <>towards {s.headsign}</>}
            <div className="muted">{s.dep} {s.from} → {s.arr} {s.to}{s.stops ? ` · ${s.stops} stops` : ''}</div></>}
          </li>))}
      </ol>
      <div className="muted small-note">{r.source}{r.dep ? ` · leave ${r.dep}` : ''}{r.arr ? ` · arrive ${r.arr}` : ''}</div>
      <button className="link" onClick={() => { setRoutes(null); if (mapCtl) showTrack(mapCtl, null); ui.set({}); }}>Close</button>
    </div>
  );
}
