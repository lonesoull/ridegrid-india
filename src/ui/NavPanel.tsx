import { nav, SIM_SPEEDS } from '../nav/navigator';
import { stage, stageOfStop } from '../nav/gmaps';
import { engine } from '../core/engine';
import { fmtKm } from '../core/geo';
import { turnText } from '../core/turns';
import { ui, useUI, act } from './state';
import { useNav } from './navHooks';
import { mapCtl } from './App';
import { Icon, TurnIcon } from './Icon';

const fmtDist = (m: number) => (m < 1000 ? `${m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50} m` : fmtKm(m));
const fmtDur = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '—';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
};
const clock = (s: number) => (Number.isFinite(s) ? new Date(Date.now() + s * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—');

export function NavPanel() {
  useNav();
  const following = useUI((s) => s.following);
  if (nav.mode === 'off') return null;
  const N = engine.stops.length;
  const done = nav.done;
  const sim = nav.mode === 'sim';
  const etaSpeed = sim ? (nav.settings.simKmh / 3.6) * nav.mult : Math.max(nav.speedMps, 35 / 3.6);
  const st = stage(stageOfStop(Math.max(0, nav.next - 1)));
  const turn = nav.nextTurn;
  const toStop = nav.distToNext;
  // the stop itself is the next "maneuver" if it comes before the next turn
  const stopFirst = !done && (!turn || toStop <= turn.dist);
  const then = stopFirst ? turn : nav.thenTurn;

  return (
    <>
      {/* Google-style instruction banner */}
      <div className={`turnbar ${nav.offRoute ? 'off' : ''}`}>
        {nav.offRoute ? (
          <div className="turnmain">
            <div className="turnicon">!</div>
            <div><div className="turndist">Off route · {Math.round(nav.offDist)} m</div>
              <div className="turntext">{nav.rerouting ? 'Finding a way back…' : nav.settings.reroute ? 'Re-routing to next stop…' : 'Return to the planned road'}</div></div>
          </div>
        ) : done ? (
          <div className="turnmain"><div className="turnicon">🏁</div><div><div className="turndist">Route complete</div></div></div>
        ) : stopFirst ? (
          <div className="turnmain">
            <div className="turnicon stopicon">{nav.next + 1}</div>
            <div><div className="turndist">{fmtDist(toStop)}</div>
              <div className="turntext">Stop #{(nav.next + 1).toLocaleString('en-IN')}{engine.stops[nav.next]?.name ? ` · ${engine.stops[nav.next].name}` : ''}</div></div>
          </div>
        ) : (
          <div className="turnmain">
            <div className="turnicon"><TurnIcon c={turn!.c} /></div>
            <div><div className="turndist">{fmtDist(turn!.dist)}</div><div className="turntext">{turnText(turn!)}</div></div>
          </div>
        )}
        {!nav.offRoute && !done && then && then.dist - (stopFirst ? toStop : turn!.dist) < 600 && (
          <div className="turnthen">Then <TurnIcon c={then.c} size={22} /> {turnText(then)}</div>
        )}
      </div>

      <div className="navpanel glass">
        {nav.gpsError && <div className="offbanner warn">{nav.gpsError}</div>}
        {!sim && !nav.pos && !nav.gpsError && <div className="muted">Waiting for GPS fix… (outdoors with open sky is fastest)</div>}
        <div className="navsummary">
          <div><b className="eta">{fmtDur(nav.remaining / etaSpeed)}</b> <span className="muted">· {fmtKm(nav.remaining)} · arrive {sim ? '—' : clock(nav.remaining / etaSpeed)}</span></div>
          <div className="muted">Next stop <b>#{Math.min(nav.next + 1, N).toLocaleString('en-IN')}</b> of {N.toLocaleString('en-IN')} · {done ? '—' : fmtDist(toStop)}
            {!sim && ` · ${Math.round(nav.speedMps * 3.6)} km/h`}{sim && ` · ${nav.settings.simKmh} km/h ×${nav.mult}`}</div>
        </div>
        <div className="navbtns">
          {sim && <button className="primary" onClick={() => nav.togglePlay()} disabled={done}><Icon name={nav.playing ? 'pause' : 'play'} /> {nav.playing ? 'Pause' : 'Play'}</button>}
          {sim && SIM_SPEEDS.map((m) => <button key={m} className={nav.mult === m ? 'on' : ''} onClick={() => nav.setMult(m)}>{m}×</button>)}
          {!following && <button onClick={() => { ui.set({ following: true }); mapCtl?.startFollow(nav.pos); }}><Icon name="target" /> Re-centre</button>}
          {st && <button title="Open this 10-leg stage in Google Maps (backup)" onClick={() => window.open(st.url, '_blank', 'noopener')}><Icon name="gmaps" size={18} /> G-Maps</button>}
          <button className="danger" onClick={() => act(null, () => nav.stop()).then(() => ui.set({ tapMode: 'append' }))}><Icon name="stop" /> Exit</button>
        </div>
        <div className="navfoot muted">
          {sim ? 'Simulation' : `GPS ±${Math.round(nav.accuracy)} m`} · {nav.wake.active ? 'screen kept on ✓' : nav.wake.supported ? 'screen lock not held' : 'keep-awake not supported'}
          {nav.ride ? ` · logging ${fmtKm(nav.ride.distM)}` : sim ? ' · not logged' : ''}
          {nav.reroutes > 0 && ` · re-routed ${nav.reroutes}×`}
          {nav.missed.length > 0 && <span className="warn"> · missed: {nav.missed.slice(-5).map((i) => `#${i + 1}`).join(', ')}{nav.missed.length > 5 ? ` (+${nav.missed.length - 5})` : ''}</span>}
        </div>
      </div>
    </>
  );
}
