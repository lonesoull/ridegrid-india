import type { LngLat } from '../core/geo';
import { nav } from '../nav/navigator';
import { say, sounds } from '../nav/audio';
import { device } from '../route/device';
import { alertData } from './offlineSearch';
import { dailyNav } from './dailyNav';
import { access } from './access';

/**
 * Daily ride screen alerts (OsmAnd "Screen alerts"): speed cameras, speed breakers, rail crossings,
 * tolls, signals, zebra crossings, stop signs, hazards on the road ahead, plus the posted speed limit
 * of the road under the rider and an over-speed warning.
 */
export type AlertKind = 'camera' | 'bump' | 'rail' | 'toll' | 'signals' | 'zebra' | 'stop' | 'hazard';
export const ALERT_ICON: Record<AlertKind, string> = { camera: '📷', bump: '⛰', rail: '🚂', toll: '💰', signals: '🚦', zebra: '🚸', stop: '🛑', hazard: '⚠️' };
export const ALERT_TEXT: Record<AlertKind, string> = { camera: 'Speed camera', bump: 'Speed breaker', rail: 'Railway crossing', toll: 'Toll plaza', signals: 'Traffic signal', zebra: 'Pedestrian crossing', stop: 'Stop sign', hazard: 'Hazard' };
const SPOKEN: Partial<Record<AlertKind, string>> = { camera: 'Speed camera ahead', bump: 'Speed breaker ahead', rail: 'Railway crossing ahead', toll: 'Toll plaza ahead', hazard: 'Hazard ahead', stop: 'Stop sign ahead' };

export interface Ahead { kind: AlertKind; dist: number; limit?: number; p: LngLat }
const RAD = Math.PI / 180;

export const roadInfo = {
  ahead: null as Ahead | null,
  road: '' as string,
  limit: null as number | null,
  over: false,
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
};

const spoken = new Map<string, number>();
let lastRoad = 0, overSince = 0, overSaid = 0;

/** Call on every rider position update in Daily mode. */
export function updateRoadInfo(p: LngLat, heading: number, speedMps: number) {
  const a = dailyNav.s.alerts;
  // nearest enabled alert in front of the rider within 600 m (and near the road ahead)
  let best: Ahead | null = null;
  const kx = Math.cos(p[1] * RAD) * 111320, ky = 110540;
  for (const arr of alertData.values()) {
    for (let i = 0; i < arr.length / 2; i++) {
      const dx = (arr[2 * i] - p[0]) * kx, dy = (arr[2 * i + 1] - p[1]) * ky;
      if (Math.abs(dx) > 600 || Math.abs(dy) > 600) continue;
      const kind = arr.kinds![i] as AlertKind;
      if (!(a as any)[kind]) continue;
      const d = Math.hypot(dx, dy);
      if (d > 600 || d < 8) continue;
      const brg = (Math.atan2(dx, dy) / RAD + 360) % 360;
      const off = Math.abs(((brg - heading + 540) % 360) - 180);
      if (off > 35) continue; // behind or off to the side
      if (!best || d < best.dist) best = { kind, dist: d, limit: arr.speeds![i] ? parseInt(arr.speeds![i], 10) || undefined : undefined, p: [arr[2 * i], arr[2 * i + 1]] };
    }
  }
  roadInfo.ahead = best;
  if (best && nav.settings.voice) {
    const key = `${best.p[0]},${best.p[1]}`;
    const warnAt = Math.max(150, speedMps * 12);
    if (best.dist <= warnAt && !spoken.has(key) && SPOKEN[best.kind]) {
      spoken.set(key, Date.now());
      sounds.arrival();
      access.buzz([150, 80, 150]);
      say(SPOKEN[best.kind]!);
    }
  }
  if (spoken.size > 500) for (const [k, t] of spoken) if (Date.now() - t > 600000) spoken.delete(k);
  // road under the rider (offline maps): name + posted limit, every ~3 s
  if (Date.now() - lastRoad > 3000) {
    lastRoad = Date.now();
    void device.roadAt(p, 30).then((r) => {
      roadInfo.road = r?.name ?? '';
      roadInfo.limit = r?.limit ?? (best?.kind === 'camera' && best.limit ? best.limit : null);
      roadInfo.emit();
    }).catch(() => {});
  }
  // over-speed warning
  const lim = roadInfo.limit;
  const over = !!lim && a.speed && speedMps * 3.6 > lim + dailyNav.s.speedTolerance;
  if (over) {
    overSince ||= Date.now();
    if (Date.now() - overSince > 4000 && Date.now() - overSaid > 30000 && nav.settings.voice) { overSaid = Date.now(); say('Slow down'); }
  } else overSince = 0;
  roadInfo.over = over;
  roadInfo.emit();
}
