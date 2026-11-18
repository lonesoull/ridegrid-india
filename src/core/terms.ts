import { engine } from './engine';

/** Expedition trips use "waypoints" (points that pin the exact roads); daily rides use real "stops". */
export const isExpedition = () => engine.trip?.kind !== 'daily';
export function T() {
  const e = isExpedition();
  return e
    ? { one: 'waypoint', many: 'waypoints', One: 'Waypoint', Many: 'Waypoints', n: (k: number) => (k === 1 ? 'waypoint' : 'waypoints') }
    : { one: 'stop', many: 'stops', One: 'Stop', Many: 'Stops', n: (k: number) => (k === 1 ? 'stop' : 'stops') };
}
