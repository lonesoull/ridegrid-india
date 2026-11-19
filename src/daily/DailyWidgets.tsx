import { useEffect, useState } from 'react';
import { nav } from '../nav/navigator';
import { useNav } from '../ui/navHooks';
import { mapCtl } from '../ui/App';
import { turnText } from '../core/turns';
import { TurnIcon } from '../ui/Icon';
import { fmtKm, haversine } from '../core/geo';
import { widgets, stats, WIDGET_LABEL, type WidgetId } from './widgets';
import { sunTimes } from './sun';
import { markers } from './markers';
import { recorder } from './recorder';
import { sensors } from './sensors';
import { moonPhase } from './mapExtras';
import { bikes, bikeStatus } from './profiles';

let bike = { km: NaN, serviceLeft: NaN };
setInterval(() => void bikeStatus().then((b) => { bike = b; }).catch(() => {}), 30000);
void Promise.resolve().then(() => bikeStatus().then((b) => { bike = b; }).catch(() => {}));

const hm = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
const dist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : fmtKm(m));
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

let battery: { level: number; charging: boolean } | null = null;
void (navigator as any).getBattery?.().then((b: any) => {
  const set = () => { battery = { level: b.level, charging: b.charging }; };
  set(); b.addEventListener('levelchange', set); b.addEventListener('chargingchange', set);
}).catch(() => {});

/** Daily map widgets panels (left and right columns), refreshed with the ride and every few seconds. */
export function DailyWidgets() {
  useNav();
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    widgets.listeners.add(f); markers.listeners.add(f); recorder.listeners.add(f); sensors.listeners.add(f); bikes.listeners.add(f);
    const i = setInterval(f, 5000);
    mapCtl?.map.on('moveend', f);
    return () => { widgets.listeners.delete(f); markers.listeners.delete(f); recorder.listeners.delete(f); sensors.listeners.delete(f); bikes.listeners.delete(f); clearInterval(i); mapCtl?.map.off('moveend', f); };
  }, []);
  const w = widgets.s;
  return (
    <>
      <div className="wcol left">{w.left.map((id) => <Widget key={id} id={id} />)}</div>
      <div className="wcol right">{w.right.map((id) => <Widget key={id} id={id} />)}</div>
    </>
  );
}

function Widget({ id }: { id: WidgetId }) {
  const v = value(id);
  if (v === null) return null;
  return <div className={`widget glass w-${id}`} title={WIDGET_LABEL[id]}>{v}</div>;
}

function value(id: WidgetId): React.ReactNode | null {
  const riding = nav.mode !== 'off';
  const mps = nav.mode === 'sim' ? (nav.settings.simKmh / 3.6) * nav.mult : nav.speedMps;
  const big = (a: React.ReactNode, b: string) => <><b>{a}</b><span>{b}</span></>;
  const rideS = stats.started ? (Date.now() - stats.started) / 1000 : 0;
  switch (id) {
    case 'speed': return riding ? big(Math.round(mps * 3.6), 'km/h') : null;
    case 'avgSpeed': return riding && stats.movingS > 30 ? big(Math.round((stats.distM / stats.movingS) * 3.6), 'avg km/h') : null;
    case 'maxSpeed': return riding ? big(Math.round(stats.maxMps * 3.6), 'max km/h') : null;
    case 'altitude': return nav.altitude !== null ? big(Math.round(nav.altitude), 'm alt') : null;
    case 'climb': return riding && stats.climbM > 0 ? big(`↗${Math.round(stats.climbM)}`, 'm climb') : null;
    case 'bearing': return riding ? big(`${Math.round(nav.heading)}°`, DIRS[Math.round(nav.heading / 45) % 8]) : null;
    case 'battery': return battery ? big(`${Math.round(battery.level * 100)}%`, battery.charging ? '⚡ battery' : 'battery') : null;
    case 'gps': return riding && nav.accuracy ? big(`±${Math.round(nav.accuracy)}`, 'm GPS') : null;
    case 'clock': return big(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), 'time');
    case 'sun': {
      const c = nav.pos ?? (mapCtl ? [mapCtl.map.getCenter().lng, mapCtl.map.getCenter().lat] : null);
      if (!c) return null;
      const s = sunTimes(new Date(), c[1], c[0]);
      const toSet = s.setAt ? (s.setAt.getTime() - Date.now()) / 1000 : -1;
      return toSet > 0 && toSet < 7200 ? big(s.set, `sunset in ${hm(toSet)}`) : big(`${s.rise}–${s.set}`, 'sun');
    }
    case 'coords': return nav.pos ? big(`${nav.pos[1].toFixed(5)}, ${nav.pos[0].toFixed(5)}`, 'my position') : null;
    case 'centre': { const c = mapCtl?.map.getCenter(); return c ? big(`${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`, 'map centre') : null; }
    case 'tripDist': return riding ? big(dist(stats.distM), 'ridden') : null;
    case 'rideTime': return riding ? big(hm(rideS), 'ride time') : null;
    case 'movingTime': return riding ? big(hm(stats.movingS), 'moving') : null;
    case 'toDest': return riding && nav.line ? big(dist(nav.remaining), 'to finish') : null;
    case 'eta': {
      if (!riding || !nav.line) return null;
      const v = Math.max(mps, 30 / 3.6);
      return big(new Date(Date.now() + (nav.remaining / v) * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }), 'arrive');
    }
    case 'toNext': return riding && nav.line ? big(dist(nav.distToNext), 'next stop') : null;
    case 'nextTurn': { const t = nav.nextTurn; return riding && t ? <><TurnIcon c={t.c} size={26} /><span>{dist(t.dist)} · {turnText(t)}</span></> : null; }
    case 'secondTurn': { const t = nav.thenTurn; return riding && t ? <><TurnIcon c={t.c} size={22} /><span>then {dist(t.dist)}</span></> : null; }
    case 'ruler': {
      const m = mapCtl?.map; if (!m) return null;
      const mpp = 156543.03 * Math.cos((m.getCenter().lat * Math.PI) / 180) / 2 ** m.getZoom();
      const raw = mpp * 80, pow = 10 ** Math.floor(Math.log10(raw)), nice = [1, 2, 5, 10].map((k) => k * pow).find((k) => k >= raw) ?? raw;
      return <><i className="rulerbar" style={{ width: `${(nice / mpp).toFixed(0)}px` }} /><span>{dist(nice)}</span></>;
    }
    case 'elevProfile': {
      const a = stats.alts; if (a.length < 3) return null;
      const min = Math.min(...a), max = Math.max(...a), span = Math.max(10, max - min);
      const pts = a.map((v, i) => `${(i / (a.length - 1)) * 100},${30 - ((v - min) / span) * 28}`).join(' ');
      return <><svg viewBox="0 0 100 30" className="miniprof"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" /></svg><span>{Math.round(min)}–{Math.round(max)} m</span></>;
    }
    case 'markers': {
      const me = nav.pos ?? (mapCtl ? [mapCtl.map.getCenter().lng, mapCtl.map.getCenter().lat] as [number, number] : null);
      const ms = markers.active().slice(0, 2);
      if (!me || !ms.length) return null;
      return <>{ms.map((k) => <span key={k.id} style={{ color: k.color }}>● {k.name}: {dist(haversine(me, k.p))}</span>)}</>;
    }
    case 'heartRate': return sensors.hr !== null ? big(`♥ ${sensors.hr}`, 'bpm') : null;
    case 'cadence': return sensors.cadence !== null ? big(Math.round(sensors.cadence), 'rpm') : null;
    case 'sensorSpeed': return sensors.speedKmh !== null ? big(Math.round(sensors.speedKmh), 'wheel km/h') : null;
    case 'temp': return sensors.tempC !== null ? big(`${sensors.tempC.toFixed(1)}°`, 'temp') : null;
    case 'fuelRange': return Number.isFinite(bike.km) ? big(`${Math.round(bike.km)} km`, bike.km < 40 ? '⛽ refuel soon!' : '⛽ range') : null;
    case 'service': return Number.isFinite(bike.serviceLeft) ? big(bike.serviceLeft > 0 ? `${Math.round(bike.serviceLeft)} km` : 'due', '🔧 service') : null;
    case 'moon': { const mp = moonPhase(); return big(mp.name.split(' ')[0], `${mp.illum}% lit`); }
    case 'recording': return recorder.on ? big(`● ${dist(recorder.distM)}`, `REC ${hm((Date.now() - recorder.startedAt) / 1000)}`) : null;
  }
}
