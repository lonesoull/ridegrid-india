import { useEffect, useState } from 'react';
import { fmtKm } from '../core/geo';
import type { TurnCode } from '../core/turns';
import { nav } from '../nav/navigator';
import { ROLE_LABEL } from '../team/team';
import { useNav } from './navHooks';
import { useTeam, riderToMirror } from './teamHooks';
import { mapCtl } from './App';
import { TurnIcon } from './Icon';

const fmtDist = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : fmtKm(m));
const fmtDur = (s: number) => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`; };

/**
 * Laptop / support device: live mirror of the riding phone — turn, next waypoint, speed, ETA and alerts.
 * Hidden while this device is navigating itself; when no phone is riding, this device works fully on its own.
 */
export function MirrorPanel() {
  useTeam(); useNav();
  const [, tick] = useState(0);
  const [follow, setFollow] = useState(false);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const p = riderToMirror();
  useEffect(() => { if (mapCtl) mapCtl.followPeerId = follow && p ? p.id : null; }, [follow, p?.id]);
  if (nav.mode !== 'off' || !p || !p.nav) return null;
  const n = p.nav;
  const age = Math.round((Date.now() - p.lastSeen) / 1000);
  const alert = n.guard && n.guard.level !== 'warn' ? (n.guard.level === 'parallel' ? 'Riding parallel to a planned road' : `Planned road ${n.guard.d} m away`) : n.offRoute ? `Off route · ${n.offDist} m` : n.detour ? 'On a detour' : '';
  const term = n.kind === 'expedition' ? 'waypoint' : 'stop';
  return (
    <div className={`mirror glass ${alert ? 'alert' : ''}`}>
      <div className="mirror-head">
        <span className="live-dot" /> <b>LIVE · {p.name}</b> <span className="muted">({ROLE_LABEL[p.role]}{n.mode === 'sim' ? ', simulation' : ''}) · {age <= 2 ? 'now' : `${age}s ago`}{p.bat !== undefined ? ` · 🔋${p.bat}%${p.charging ? '⚡' : ''}` : ''}</span>
      </div>
      {alert && <div className="offbanner">{alert}</div>}
      {n.turn && <div className="mirror-turn"><TurnIcon c={n.turn.c as TurnCode} size={34} /><div><b>{fmtDist(n.turn.dist)}</b> · {n.turn.txt}</div></div>}
      <div className="navstats">
        <div><div className="muted">Next {term}</div><b>#{(n.next + 1).toLocaleString('en-IN')}</b></div>
        <div><div className="muted">To next</div><b>{fmtDist(n.toNext)}</b></div>
        <div><div className="muted">Speed</div><b>{Math.round((p.spd ?? 0) * 3.6)} km/h</b></div>
        <div><div className="muted">ETA</div><b>{fmtDur(n.etaS)}</b></div>
      </div>
      <div className="muted">{n.trip} · {fmtKm(n.remaining)} left · {n.total.toLocaleString('en-IN')} {term}s</div>
      <div className="btns sm">
        <button className={follow ? 'primary' : ''} onClick={() => setFollow(!follow)}>{follow ? 'Following rider' : 'Follow rider'}</button>
        <button onClick={() => p.pos && mapCtl?.map.flyTo({ center: p.pos, zoom: 15 })}>Show on map</button>
      </div>
    </div>
  );
}
