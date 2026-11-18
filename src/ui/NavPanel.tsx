import { nav, SIM_SPEEDS } from '../nav/navigator';
import { stage, stageOfStop } from '../nav/gmaps';
import { engine } from '../core/engine';
import { fmtKm } from '../core/geo';
import { turnText } from '../core/turns';
import { isExpedition, T } from '../core/terms';
import { ui, useUI, act, toast } from './state';
import { useNav } from './navHooks';
import { mapCtl } from './App';
import { Icon, TurnIcon } from './Icon';
import { isNativeApp } from '../nav/gps';
import { team } from '../team/team';
import { sendSos } from '../team/actions';
import { useEffect, useRef, useState } from 'react';
import { compliance } from '../nav/compliance';

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
  // daily + Google: live-traffic time to the next stop (kept fresh by the faster-route checks)
  const live = !sim && nav.liveEta && Date.now() - nav.liveEta.at < 5 * 60000 ? nav.liveEta : null;
  const etaS = live ? Math.max(0, live.toNextS - (Date.now() - live.at) / 1000) + Math.max(0, nav.remaining - nav.distToNext) / etaSpeed : nav.remaining / etaSpeed;
  const st = stage(stageOfStop(Math.max(0, nav.next - 1)));
  const turn = nav.nextTurn;
  const toStop = nav.distToNext;
  // the stop itself is the next "maneuver" if it comes before the next turn
  const exp = isExpedition();
  const t = T();
  const guard = nav.guard;
  const detour = exp ? nav.detour : null;
  // daily: the stop itself is the next "maneuver" if it comes before the next turn; expedition: waypoints are never destinations
  const stopFirst = !exp && !done && (!turn || toStop <= turn.dist);
  const then = stopFirst ? turn : nav.thenTurn;

  return (
    <>
      {/* Google-style instruction banner */}
      <div className={`turnbar ${guard && guard.level !== 'warn' ? 'off' : detour ? 'detour' : nav.offRoute ? 'off' : ''}`}>
        {guard && guard.level !== 'warn' ? (
          <div className="turnmain">
            <div className="turnicon">⚠</div>
            <div><div className="turndist">{guard.level === 'parallel' ? 'Parallel to planned road' : `Planned road ${Math.round(guard.d)} m`}</div>
              <div className="turntext">{guard.level === 'parallel' ? 'Move away — this runs alongside your route' : `Keep at least ${nav.settings.gapM} m away — turn back`}</div></div>
          </div>
        ) : detour && !nav.approach ? (
          <div className="turnmain">
            <div className="turnicon">↪</div>
            <div><div className="turndist">Detour · {Math.round(nav.offDist)} m off route</div>
              <div className="turntext">{guard?.level === 'warn' ? `Careful: planned road ${Math.round(guard.d)} m ahead` : `Left route at ${fmtKm(detour.depS)} — no other planned road nearby`}</div></div>
          </div>
        ) : nav.offRoute ? (
          <div className="turnmain">
            <div className="turnicon">!</div>
            <div><div className="turndist">Off route · {Math.round(nav.offDist)} m</div>
              <div className="turntext">{nav.rerouting ? 'Finding a way back…' : nav.settings.reroute && !exp ? `Re-routing to next ${t.one}…` : 'Return to the planned road'}</div></div>
          </div>
        ) : done ? (
          <div className="turnmain"><div className="turnicon">🏁</div><div><div className="turndist">Route complete</div></div></div>
        ) : exp && !turn ? (
          <div className="turnmain">
            <div className="turnicon"><TurnIcon c="straight" /></div>
            <div><div className="turndist">{fmtKm(nav.remaining)}</div><div className="turntext">Continue on planned route</div></div>
          </div>
        ) : stopFirst ? (
          <div className="turnmain">
            <div className="turnicon stopicon">{nav.next + 1}</div>
            <div><div className="turndist">{fmtDist(toStop)}</div>
              <div className="turntext">{t.One} #{(nav.next + 1).toLocaleString('en-IN')}{engine.stops[nav.next]?.name ? ` · ${engine.stops[nav.next].name}` : ''}</div></div>
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
        <CompAlerts />
        {!sim && !nav.pos && !nav.gpsError && <div className="muted">Waiting for GPS fix… (outdoors with open sky is fastest)</div>}
        <div className="navsummary">
          <div><b className="eta">{done ? 'Arrived' : fmtDur(etaS)}</b> <span className="muted">· {fmtKm(nav.remaining)} · arrive {sim ? '—' : clock(etaS)}{live ? ' · live traffic' : ''}</span></div>
          <div className="muted">Next {t.one} <b>#{Math.min(nav.next + 1, N).toLocaleString('en-IN')}</b> of {N.toLocaleString('en-IN')} · {done ? '—' : fmtDist(toStop)}
            {!sim && ` · ${Math.round(nav.speedMps * 3.6)} km/h`}{sim && ` · ${nav.settings.simKmh} km/h ×${nav.mult}`}</div>
        </div>
        {nav.faster && (
          <div className="fasterbar">
            <div><b>Faster route available</b><div className="muted">Saves {Math.round(nav.faster.savingS / 60)} min with current traffic</div></div>
            <button className="primary" onClick={() => nav.takeFaster()}>Take it</button>
            <button onClick={() => nav.ignoreFaster()}>Ignore</button>
          </div>
        )}
        {detour && !nav.approach && !sim && (
          <div className="navbtns">
            <button className="primary" onClick={() => { if (!nav.returnSameWay()) toast('No path recorded yet'); }}>↩ Return the way I came</button>
            <button onClick={() => act('Planning a way back that keeps the gap…', async () => {
              const r = await nav.planSafeWayBack();
              if (r.ok || confirm(`The best way back passes ${Math.round(r.minGapM)} m from another planned road (you need ${nav.settings.gapM} m). Use it anyway?`)) nav.useSafeWayBack(r);
            })}>Safe way back</button>
          </div>
        )}
        {detour?.returning && nav.approach && <div className="muted">Returning {detour.returning === 'same' ? 'the way you came' : 'by the safe route'} to where you left the route.</div>}
        <div className="navbtns">
          {sim && <button className="primary" onClick={() => nav.togglePlay()} disabled={done}><Icon name={nav.playing ? 'pause' : 'play'} /> {nav.playing ? 'Pause' : 'Play'}</button>}
          {sim && SIM_SPEEDS.map((m) => <button key={m} className={nav.mult === m ? 'on' : ''} onClick={() => nav.setMult(m)}>{m}×</button>)}
          {!following && <button onClick={() => { ui.set({ following: true }); mapCtl?.startFollow(nav.pos); }}><Icon name="target" /> Re-centre</button>}
          {!sim && <button className="logbtn" onClick={() => ui.set({ logStop: true })}>Log stop</button>}
          {team.settings && <SosHold />}
          {st && <button title="Open this 10-leg stage in Google Maps (backup)" onClick={() => window.open(st.url, '_blank', 'noopener')}><Icon name="gmaps" size={18} /> G-Maps</button>}
          <button className="danger" onClick={() => act(null, () => nav.stop()).then(() => ui.set({ tapMode: 'append' }))}><Icon name="stop" /> Exit</button>
        </div>
        <div className="navfoot muted">
          {sim ? 'Simulation' : `GPS ±${Math.round(nav.accuracy)} m`} · {!sim && isNativeApp() ? 'background GPS ✓' : nav.wake.active ? 'screen kept on ✓' : nav.wake.supported ? 'screen lock not held' : 'keep-awake not supported'}
          {nav.mockFixes > 0 && <span className="danger-text"> · FAKE GPS blocked ×{nav.mockFixes}</span>}
          {nav.ride ? ` · logging ${fmtKm(nav.ride.distM)}` : sim ? ' · not logged' : ''}
          {nav.reroutes > 0 && ` · re-routed ${nav.reroutes}×`}
          {nav.routeUpdates > 0 && <span className="warn"> · planned route changed {nav.routeUpdates}× during this ride</span>}
          {nav.joinedAt !== null && ` · joined route before #${nav.joinedAt + 1}`}
          {nav.missed.length > 0 && <span className="warn"> · missed: {nav.missed.slice(-5).map((i) => `#${i + 1}`).join(', ')}{nav.missed.length > 5 ? ` (+${nav.missed.length - 5})` : ''}</span>}
        </div>
      </div>
    </>
  );
}

/** SOS while riding: hold 1.5 s (no accidental taps with gloves). */
function SosHold() {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hold, setHold] = useState(false);
  const start = () => { setHold(true); t.current = setTimeout(() => { setHold(false); void act('Sending SOS…', async () => { await sendSos(); toast('SOS sent to the team'); }); }, 1500); };
  const cancel = () => { setHold(false); if (t.current) clearTimeout(t.current); };
  return <button className={`sosbtn ${hold ? 'holding' : ''}`} onPointerDown={start} onPointerUp={cancel} onPointerLeave={cancel}>{hold ? 'Keep holding…' : 'Hold for SOS'}</button>;
}

/** Guinness / India rule alerts (expressway, speed, permit zone, night closure, halt). */
function CompAlerts() {
  const [, tick] = useState(0);
  useEffect(() => compliance.subscribe(() => tick((x) => x + 1)), []);
  const list = [...compliance.alerts.values()];
  if (!list.length) return null;
  return <div className="compalerts">{list.map((a) => <div key={a.kind} className={`comp ${a.level}`}>{a.text}</div>)}</div>;
}
