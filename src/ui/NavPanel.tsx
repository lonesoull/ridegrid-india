import { nav, SIM_SPEEDS } from '../nav/navigator';
import { stage, stageOfStop } from '../nav/gmaps';
import { engine } from '../core/engine';
import { fmtKm } from '../core/geo';
import { ui, useUI, act } from './state';
import { useNav } from './navHooks';
import { mapCtl } from './App';

const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : fmtKm(m));
const fmtDur = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

export function NavPanel() {
  useNav();
  const following = useUI((s) => s.following);
  if (nav.mode === 'off') return null;
  const N = engine.stops.length;
  const done = nav.done;
  const sim = nav.mode === 'sim';
  const kmh = nav.speedMps * 3.6;
  const etaSpeed = sim ? (nav.settings.simKmh / 3.6) * nav.mult : Math.max(nav.speedMps, 40 / 3.6);
  const st = stage(stageOfStop(Math.max(0, nav.next - 1)));

  return (
    <div className={`navpanel glass ${nav.offRoute ? 'off' : ''}`}>
      {nav.offRoute && <div className="offbanner">⚠ OFF ROUTE — {Math.round(nav.offDist)} m from planned road</div>}
      {nav.gpsError && <div className="offbanner warn">{nav.gpsError}</div>}
      {!sim && !nav.pos && !nav.gpsError && <div className="muted">Waiting for GPS fix… (go outdoors, sky view helps)</div>}
      <div className="navmain">
        <div className="next">
          {done ? <b>🏁 Route complete</b> : <>
            <div className="muted">Next stop</div>
            <b className="big">#{(nav.next + 1).toLocaleString('en-IN')}</b>
            <span className="muted"> of {N.toLocaleString('en-IN')}{engine.stops[nav.next]?.name ? ` · ${engine.stops[nav.next].name}` : ''}</span>
          </>}
        </div>
        <div className="navstats">
          <div><div className="muted">To next</div><b>{done ? '—' : fmtDist(nav.distToNext)}</b></div>
          <div><div className="muted">Left</div><b>{fmtKm(nav.remaining)}</b></div>
          <div><div className="muted">{sim ? 'Sim speed' : 'Speed'}</div><b>{sim ? `${nav.settings.simKmh} km/h ×${nav.mult}` : `${Math.round(kmh)} km/h`}</b></div>
          <div><div className="muted">ETA</div><b>{fmtDur(nav.remaining / etaSpeed)}</b></div>
        </div>
      </div>
      <div className="navbtns">
        {sim && <button className="primary" onClick={() => nav.togglePlay()} disabled={done}>{nav.playing ? '⏸ Pause' : '▶ Play'}</button>}
        {sim && SIM_SPEEDS.map((m) => <button key={m} className={nav.mult === m ? 'on' : ''} onClick={() => nav.setMult(m)}>{m}×</button>)}
        {!following && <button onClick={() => { ui.set({ following: true }); mapCtl?.startFollow(nav.pos); }}>🎯 Re-centre</button>}
        {st && <button title="Open this 10-leg stage in Google Maps (backup)" onClick={() => window.open(st.url, '_blank', 'noopener')}>G-Maps stage {st.n}</button>}
        <button className="danger" onClick={() => act(null, () => nav.stop()).then(() => ui.set({ tapMode: 'append' }))}>⏹ Stop</button>
      </div>
      <div className="navfoot muted">
        {sim ? 'Simulation' : `GPS ±${Math.round(nav.accuracy)} m`} · {nav.wake.active ? 'screen kept on ✓' : nav.wake.supported ? 'screen lock not held' : 'keep-awake not supported'}
        {nav.ride ? ` · logging ${fmtKm(nav.ride.distM)}` : sim ? ' · not logged' : ''}
        {nav.missed.length > 0 && <span className="warn"> · missed stops: {nav.missed.slice(-5).map((i) => `#${i + 1}`).join(', ')}{nav.missed.length > 5 ? ` (+${nav.missed.length - 5})` : ''}</span>}
      </div>
    </div>
  );
}
