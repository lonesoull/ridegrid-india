import { useEffect, useState } from 'react';
import { nav } from '../nav/navigator';
import { roadInfo, ALERT_ICON, ALERT_TEXT } from './roadAlerts';
import { TurnIcon } from '../ui/Icon';
import type { TurnCode } from '../core/turns';

const ARROW: Record<string, TurnCode> = { left: 'left', 'slight left': 'slight-left', 'sharp left': 'sharp-left', right: 'right', 'slight right': 'slight-right', 'sharp right': 'sharp-right', straight: 'straight', uturn: 'uturn', none: 'straight' };
const fmt = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/** Daily ride screen: lanes, speed-limit sign, current street, next road alert (OsmAnd widgets). */
export function DailyNavExtras() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((x) => x + 1); roadInfo.listeners.add(f); return () => { roadInfo.listeners.delete(f); }; }, []);
  const turn = nav.nextTurn;
  const lanes = turn?.l && turn.dist < 1200 ? turn.l.split('|') : null;
  const a = roadInfo.ahead;
  const kmh = Math.round(nav.speedMps * 3.6);
  return (
    <div className="dnav">
      {lanes && (
        <div className="lanes glass">
          {lanes.map((ln, i) => {
            const use = ln.endsWith('*');
            const arrows = ln.replace('*', '').split('+');
            return <span key={i} className={use ? 'use' : ''}>{arrows.map((x, j) => <TurnIcon key={j} c={ARROW[x] ?? 'straight'} size={26} />)}</span>;
          })}
        </div>
      )}
      <div className="dnav-row">
        {roadInfo.limit && <div className={`speedsign ${roadInfo.over ? 'over' : ''}`} title="Speed limit"><b>{roadInfo.limit}</b></div>}
        {nav.mode !== 'off' && <div className={`speedo glass ${roadInfo.over ? 'over' : ''}`}><b>{kmh}</b><span>km/h</span></div>}
        {a && <div className={`ralert glass k-${a.kind}`}><span className="ri">{ALERT_ICON[a.kind]}</span><span><b>{ALERT_TEXT[a.kind]}</b>{a.limit ? ` · ${a.limit}` : ''}<br />{fmt(a.dist)}</span></div>}
      </div>
      {roadInfo.road && <div className="street glass">{roadInfo.road}</div>}
    </div>
  );
}
