import { Capacitor, registerPlugin } from '@capacitor/core';
import { nav } from '../nav/navigator';
import { turnText } from '../core/turns';
import { roadInfo } from './roadAlerts';

/** Android Auto: pushes the current turn / distance / road / arrival to the car screen (Daily mode). */
interface CarBridge { update(o: Record<string, unknown>): Promise<void> }
const car = registerPlugin<CarBridge>('CarBridge');
let last = 0, wasNav = false;

export function pushToCar() {
  if (!Capacitor.isNativePlatform()) return;
  const navigating = nav.mode === 'live' && !!nav.line;
  if (!navigating && !wasNav) return;
  if (navigating && Date.now() - last < 1000) return;
  last = Date.now(); wasNav = navigating;
  const t = nav.nextTurn;
  const v = Math.max(nav.speedMps, 30 / 3.6);
  void car.update({
    navigating, turn: t?.c ?? 'straight', text: t ? turnText(t) : 'Continue', road: t?.n ?? roadInfo.road ?? '', distM: t?.dist ?? nav.distToNext,
    remainingM: nav.remaining, etaMs: navigating ? Date.now() + (nav.remaining / v) * 1000 : 0, exit: t?.x ?? 0,
    speedKmh: Math.round(nav.speedMps * 3.6), limit: roadInfo.limit ?? 0,
  }).catch(() => {});
}
