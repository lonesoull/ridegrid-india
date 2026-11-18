import { useState } from 'react';
import { isExpedition } from '../core/terms';
import { compliance, ILP_STATES, NIGHT_CLOSURES, PERMIT_AREAS } from '../nav/compliance';
import { T } from '../core/terms';
import { nav, type NavSettings } from '../nav/navigator';
import { sounds, say } from '../nav/audio';
import { stage, stageCount, stagesCSV, LEGS_PER_STAGE } from '../nav/gmaps';
import { listRides, deleteRide, rideGPX } from '../nav/rides';
import { engine } from '../core/engine';
import { fmtKm } from '../core/geo';
import { download, safeName } from '../io/exporters';
import { act, toast, ui } from './state';
import { useAsync, useEngine } from './hooks';
import { useNav } from './navHooks';
import { startRide } from './startRide';
import { Icon } from './Icon';

export function RideTab() {
  useEngine(); useNav();
  const n = engine.stops.length;
  const [from, setFrom] = useState('1');
  const [stagePage, setStagePage] = useState(0);
  const [rides, reloadRides] = useAsync(() => listRides(engine.trip!.id), [engine.trip?.id, nav.mode]);
  const s = nav.settings;
  const set = (p: Partial<NavSettings>) => void nav.setSettings(p);
  const fromIdx = Math.max(0, Math.min(n - 1, (parseInt(from) || 1) - 1));
  const pending = engine.pendingLegs + engine.errorLegs;

  const start = (mode: 'live' | 'sim') => act(mode === 'live' ? 'Starting navigation…' : 'Starting simulation…', () => startRide(mode, fromIdx));

  const stages = stageCount();
  const PER = 20;
  const pageStages = Array.from({ length: Math.min(PER, Math.max(0, stages - stagePage * PER)) }, (_, i) => stage(stagePage * PER + i)!);

  return (
    <div className="stack">
      <section>
        <h3>Ride this route</h3>
        {n < 2 && <p className="warn">Add at least 2 {T().many} first.</p>}
        {pending > 0 && <p className="warn">{pending.toLocaleString('en-IN')} legs are not road-mapped yet — they are followed as straight lines until mapped.</p>}
        <label className="field">Start from {T().one} #
          <input inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <div className="btns">
          <button className="primary" disabled={n < 2 || nav.mode !== 'off'} onClick={() => start('live')}><Icon name="play" /> Start GPS navigation</button>
          <button disabled={n < 2 || nav.mode !== 'off'} onClick={() => start('sim')}><Icon name="sim" /> Simulate ride</button>
        </div>
        {nav.mode !== 'off' && <button className="danger" onClick={() => act(null, () => nav.stop())}><Icon name="stop" /> Stop {nav.mode === 'sim' ? 'simulation' : 'navigation'}</button>}
        <p className="muted">Keeps the screen on while riding. Simulation glides along your exact road route at 1× / 10× / 50× / 500× ({s.simKmh} km/h base) for desk testing.</p>
      </section>

      <section>
        <h3>Alerts</h3>
        <label className="field">Off-route alert when more than <b>{s.offRouteM} m</b> from the planned road
          <input type="range" min={25} max={200} step={5} value={s.offRouteM} onChange={(e) => set({ offRouteM: +e.target.value })} />
        </label>
        <label className="field">{T().One} counts as reached within <b>{s.arrivalM} m</b>
          <input type="range" min={15} max={100} step={5} value={s.arrivalM} onChange={(e) => set({ arrivalM: +e.target.value })} />
        </label>
        {!isExpedition() && <label className="field">Look for a faster route with live traffic (needs Google mode)
          <select value={s.fasterSec} onChange={(e) => set({ fasterSec: +e.target.value })}>
            <option value={60}>Every 1 minute</option><option value={120}>Every 2 minutes</option><option value={300}>Every 5 minutes</option><option value={0}>Off</option>
          </select>
        </label>}
        {isExpedition() && <label className="field">Expedition gap: keep at least <b>{s.gapM} m</b> from every other planned road (crossings, sub-roads, flyovers, parallel roads)
          <input type="range" min={20} max={100} step={5} value={s.gapM} onChange={(e) => set({ gapM: +e.target.value })} />
        </label>}
        <label className="field">Simulation base speed <b>{s.simKmh} km/h</b>
          <input type="range" min={20} max={100} step={5} value={s.simKmh} onChange={(e) => set({ simKmh: +e.target.value })} />
        </label>
        <label className="check"><input type="checkbox" checked={s.beep} onChange={(e) => set({ beep: e.target.checked })} /><span>Audio beeps (off-route alarm, arrival chime)</span></label>
        <label className="check"><input type="checkbox" checked={s.voice} onChange={(e) => set({ voice: e.target.checked })} /><span>Voice announcements (helmet speaker)</span></label>
        <label className="check"><input type="checkbox" checked={s.reroute} onChange={(e) => set({ reroute: e.target.checked })} /><span>Auto re-route back to the next stop when off route (like Google Maps)</span></label>
        <label className="check"><input type="checkbox" checked={s.logSim} onChange={(e) => set({ logSim: e.target.checked })} /><span>Log simulated rides too (testing — adds to “covered”)</span></label>
        <div className="btns">
          <button onClick={() => sounds.offRoute()}>Test off-route alarm</button>
          <button onClick={() => { sounds.arrival(); say('Stop 12 reached. Next, stop 13'); }}>Test arrival</button>
        </div>
      </section>

      <RulesSection />

      <section>
        <h3>Logbook</h3>
        <p className="muted">Start/end of day, stops, breaks, photos and the printable logbook now have their own tab.</p>
        <button className="logbtn" onClick={() => ui.set({ tab: 'log' })}>Open Logbook</button>
      </section>

      <section>
        <h3>Google Maps backup stages</h3>
        <p className="muted">Your exact point order split into {stages.toLocaleString('en-IN')} two-wheeler links of {LEGS_PER_STAGE} legs each (origin + 9 waypoints + destination — Google's limit). Order is locked; Google never reorders these.</p>
        <div className="btns">
          <button disabled={!stages} onClick={() => download(`${safeName(engine.trip!.name)}_google_maps_stages.csv`, stagesCSV(), 'text/csv')}>Download all as .csv</button>
          <button disabled={!stages} onClick={() => { const st = stage(Math.floor(fromIdx / LEGS_PER_STAGE)); if (st) window.open(st.url, '_blank', 'noopener'); }}>Open stage for {T().one} #{fromIdx + 1}</button>
        </div>
        {stages > 0 && <>
          <div className="list">
            {pageStages.map((st) => (
              <div className="item tight" key={st.n}>
                <a className="link" href={st.url} target="_blank" rel="noopener noreferrer"><b>Stage {st.n}</b> <span className="muted">{T().many} #{st.from + 1} → #{st.to + 1}</span></a>
                <button className="sm" onClick={() => navigator.clipboard?.writeText(st.url).then(() => toast('Link copied'))}>Copy</button>
              </div>
            ))}
          </div>
          {stages > PER && <div className="pager">
            <button disabled={stagePage === 0} onClick={() => setStagePage(stagePage - 1)}>◀ Prev</button>
            <span>{stagePage * PER + 1}–{Math.min(stages, stagePage * PER + PER)} of {stages.toLocaleString('en-IN')}</span>
            <button disabled={(stagePage + 1) * PER >= stages} onClick={() => setStagePage(stagePage + 1)}>Next ▶</button>
          </div>}
        </>}
      </section>

      <section>
        <h3>Ride logs</h3>
        <p className="muted">Every real GPS ride is recorded with a UTC timestamp on each point and adds to “Covered”. Export as GPX 1.1 for your evidence pack.</p>
        {!rides?.length && <p className="muted">No rides logged yet.</p>}
        {rides?.map((r) => (
          <div className="item" key={r.id}>
            <div><b>{r.name}</b>{r.simulated && <span className="pill" style={{ marginLeft: 6 }}>simulated</span>}
              <div className="muted">{fmtKm(r.distM)} · {r.points.toLocaleString('en-IN')} points{r.endedAt ? ` · ${Math.round((r.endedAt - r.startedAt) / 60000)} min` : ' · in progress'}</div></div>
            <div className="btns sm">
              <button onClick={() => act('Building GPX…', async () => download(`${safeName(r.name)}.gpx`, await rideGPX(r), 'application/gpx+xml'))}>Export .gpx</button>
              <button className="danger" disabled={!r.endedAt} onClick={() => confirm(`Delete “${r.name}” and remove ${fmtKm(r.distM)} from covered?`) && act(null, () => deleteRide(r.id)).then(reloadRides)}>Delete</button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}


function RulesSection() {
  const [, tick] = useState(0);
  const c = compliance.settings;
  const set = (p: Partial<typeof c>) => void compliance.setSettings(p).then(() => tick((x) => x + 1));
  return (
    <section>
      <h3>Record rules (alerts while riding)</h3>
      <p className="muted">Expressway and speed alerts apply to expedition trips only. Daily trips may use expressways and get no speed alerts.</p>
      <label className="check"><input type="checkbox" checked={c.speedOn} onChange={(e) => set({ speedOn: e.target.checked })} /><span>Speed alert above <b>{c.speedNH}</b> km/h on National Highways, <b>{c.speedOther}</b> km/h elsewhere</span></label>
      <div className="grid2">
        <label className="field">NH limit (km/h)<input type="number" value={c.speedNH} onChange={(e) => set({ speedNH: +e.target.value || 80 })} /></label>
        <label className="field">Other roads (km/h)<input type="number" value={c.speedOther} onChange={(e) => set({ speedOther: +e.target.value || 60 })} /></label>
      </div>
      <label className="field">Maximum halt in one place: <b>{c.haltHours} h</b> (within {c.haltRadiusKm} km)
        <input type="range" min={12} max={72} step={1} value={c.haltHours} onChange={(e) => set({ haltHours: +e.target.value })} />
      </label>
      <label className="check"><input type="checkbox" checked={c.permitOn} onChange={(e) => set({ permitOn: e.target.checked })} /><span>Permit-zone alerts (Inner Line Permit states: {ILP_STATES.join(', ')}; Ladakh & Sikkim protected areas)</span></label>
      <label className="check"><input type="checkbox" checked={c.nightOn} onChange={(e) => set({ nightOn: e.target.checked })} /><span>Night-closure alerts for forest roads</span></label>
      <details>
        <summary className="muted">Night-closed roads & permit areas in the app</summary>
        <ul className="muted small">
          {NIGHT_CLOSURES.map((n) => <li key={n.name}>{n.name}: closed {n.from}:00–{String(n.to).padStart(2, '0')}:00</li>)}
          {PERMIT_AREAS.map((a) => <li key={a.name}>{a.name} — {a.note}</li>)}
        </ul>
        <p className="muted small-note">Approximate areas and timings — check locally, rules change. Two-wheeler-banned expressways come from OpenStreetMap and are avoided in routing automatically.</p>
      </details>
    </section>
  );
}
