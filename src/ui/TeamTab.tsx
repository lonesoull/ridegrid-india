import { useEffect, useState } from 'react';
import { team, ROLE_LABEL, DEFAULT_BROKER, type Role } from '../team/team';
import { isValidCode, normalizeCode } from '../team/crypto';
import { pushRoute, sendSos } from '../team/actions';
import { engine } from '../core/engine';
import { fmtKm } from '../core/geo';
import { ui, act, toast } from './state';
import { useTeam } from './teamHooks';
import { mapCtl } from './App';
import { ROLE_COLOR } from '../map/MapController';

const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 5 ? 'now' : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

/** Pair the team's devices (2 phones + laptop), see them live, push the route, SOS. */
export function TeamTab() {
  useTeam();
  const s = team.settings;
  const [name, setName] = useState(s?.name ?? '');
  const [role, setRole] = useState<Role>(s?.role ?? (/(Android|iPhone)/i.test(navigator.userAgent) ? 'primary' : 'laptop'));
  const [code, setCode] = useState(() => (location.hash.startsWith('#join=') ? normalizeCode(location.hash.slice(6)) : ''));
  const [broker, setBroker] = useState(s?.broker ?? DEFAULT_BROKER);
  useEffect(() => { if (location.hash.startsWith('#join=')) history.replaceState(null, '', location.pathname); }, []);

  const roles = (
    <div className="seg three">
      {(['primary', 'secondary', 'laptop'] as Role[]).map((r) => (
        <button key={r} className={role === r ? 'on' : ''} onClick={() => { setRole(r); if (s) void team.update({ role: r }); }}><b>{ROLE_LABEL[r]}</b></button>
      ))}
    </div>
  );

  if (!s) {
    return (
      <div className="stack">
        <section>
          <h3>Team link</h3>
          <p className="muted">Connect your 2 phones and laptop: each device sees the others live on the map (position, speed, battery, navigation), the laptop mirrors the riding phone, routes can be sent between devices, and SOS reaches everyone. End-to-end encrypted — the relay only sees scrambled data.</p>
          <label className="field">This device's name<input value={name} placeholder="e.g. Handlebar phone" onChange={(e) => setName(e.target.value)} /></label>
          <div className="field">This device is the…</div>
          {roles}
        </section>
        <section>
          <h3>First device: create the team</h3>
          <button className="primary" onClick={() => act('Creating team…', () => team.create(name, role))}>Create team</button>
        </section>
        <section>
          <h3>Other devices: join with the code</h3>
          <input placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="primary" disabled={!isValidCode(code)} onClick={() => act('Joining…', () => team.join(code, name, role))}>Join team</button>
        </section>
      </div>
    );
  }

  const peers = [...team.peers.values()].sort((a, b) => a.role.localeCompare(b.role));
  return (
    <div className="stack">
      <section>
        <h3>Team link <span className={`pill ${team.status === 'online' ? '' : 'pill-warn'}`}>{team.status === 'online' ? 'connected' : team.status}</span></h3>
        <p className="muted">This device: <b>{s.name}</b> · {ROLE_LABEL[s.role]}</p>
        {roles}
        {team.lastError && team.status !== 'online' && <p className="warn">{team.lastError}</p>}
      </section>

      <section>
        <h3>Devices</h3>
        {!peers.length && <p className="muted">No other device yet. Share the code below with your other phone and laptop.</p>}
        {peers.map((p) => (
          <div className="item" key={p.id}>
            <div><span className="dot" style={{ background: ROLE_COLOR[p.role] }} /> <b>{p.name}</b> <span className="muted">· {ROLE_LABEL[p.role]} · {p.online ? `online ${ago(p.lastSeen)}` : `offline since ${ago(p.t)}`}</span></div>
            <div className="muted">{p.nav ? `${p.nav.mode === 'sim' ? 'Simulating' : 'Riding'} “${p.nav.trip}” · ${Math.round((p.spd ?? 0) * 3.6)} km/h · ${fmtKm(p.nav.remaining)} left` : 'Not navigating'}
              {p.bat !== undefined ? ` · battery ${p.bat}%${p.charging ? ' (charging)' : ''}` : ''}{p.acc ? ` · GPS ±${p.acc} m` : ''}{p.track.length > 1 ? ` · ${p.track.length} track points` : ''}</div>
            {p.pos && <div className="btns sm"><button onClick={() => { mapCtl?.map.flyTo({ center: p.pos!, zoom: 15 }); ui.set({ drawer: false }); }}>Show on map</button></div>}
          </div>
        ))}
      </section>

      <section>
        <h3>Send route to team</h3>
        <p className="muted">Sends “{engine.trip?.name}” ({engine.stops.length.toLocaleString('en-IN')} points) to the other devices; they're asked before it's loaded.</p>
        <button disabled={!engine.stops.length} onClick={() => act('Sending route…', async () => { const r = await pushRoute(); toast(`Route sent (${r.count.toLocaleString('en-IN')} points)`); })}>Send my route</button>
      </section>

      <section>
        <h3>SOS</h3>
        <p className="muted">Sends your exact location to every team device with a loud alarm.</p>
        <button className="sosbtn" onClick={() => confirm('Send SOS with your location to the whole team?') && act('Sending SOS…', async () => { await sendSos(); toast('SOS sent to the team'); })}>SOS</button>
      </section>

      <section>
        <h3>Invite another device</h3>
        <p className="muted">On the other device open RideGrid → Team → enter this code (or open the link there).</p>
        <div className="code">{s.code}</div>
        <div className="btns">
          <button onClick={() => navigator.clipboard?.writeText(s.code).then(() => toast('Code copied'))}>Copy code</button>
          <button onClick={() => (navigator.share ? navigator.share({ title: 'Join my RideGrid team', url: team.inviteLink }).catch(() => undefined) : navigator.clipboard?.writeText(team.inviteLink).then(() => toast('Link copied')))}>Share link</button>
        </div>
        <p className="muted small-note">Anyone with this code can see your live location — share it only with your own devices/team.</p>
      </section>

      <section>
        <details>
          <summary className="muted">Advanced: relay server</summary>
          <p className="muted">Free public MQTT relay (end-to-end encrypted). All devices must use the same address.</p>
          <input value={broker} onChange={(e) => setBroker(e.target.value.trim())} />
          <button onClick={() => act(null, () => team.update({ broker }))}>Save relay</button>
        </details>
        <button className="danger" onClick={() => confirm('Leave the team on this device?') && act(null, () => team.leave())}>Leave team</button>
      </section>
    </div>
  );
}
