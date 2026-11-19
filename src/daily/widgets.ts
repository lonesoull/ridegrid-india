import { getSetting, putSetting } from '../core/db';
import { nav } from '../nav/navigator';
import { haversine, type LngLat } from '../core/geo';

/** Daily ride map widgets (OsmAnd "Configure screen"). */
export type WidgetId =
  | 'speed' | 'avgSpeed' | 'maxSpeed' | 'altitude' | 'climb' | 'bearing' | 'battery' | 'gps' | 'clock' | 'sun'
  | 'coords' | 'centre' | 'tripDist' | 'rideTime' | 'movingTime' | 'toDest' | 'eta' | 'toNext' | 'nextTurn' | 'secondTurn'
  | 'ruler' | 'elevProfile' | 'markers' | 'recording' | 'heartRate' | 'cadence' | 'sensorSpeed' | 'temp' | 'fuelRange' | 'service' | 'moon';
export const WIDGET_LABEL: Record<WidgetId, string> = {
  speed: 'Current speed', avgSpeed: 'Average speed', maxSpeed: 'Max speed', altitude: 'Altitude', climb: 'Climb so far', bearing: 'Heading',
  battery: 'Battery', gps: 'GPS accuracy', clock: 'Clock', sun: 'Sunrise / sunset', coords: 'My coordinates', centre: 'Map-centre coordinates',
  tripDist: 'Trip distance', rideTime: 'Ride time', movingTime: 'Moving time', toDest: 'Distance to destination', eta: 'Arrival time',
  toNext: 'Distance to next stop', nextTurn: 'Next turn', secondTurn: 'Second next turn', ruler: 'Scale ruler', elevProfile: 'Altitude graph',
  markers: 'Distance to markers', recording: 'Track recording',
  heartRate: 'Heart rate (Bluetooth)', cadence: 'Cadence (Bluetooth)', sensorSpeed: 'Wheel speed (Bluetooth)', temp: 'Temperature (Bluetooth)', fuelRange: 'Fuel range', service: 'Next service', moon: 'Moon phase',
};
export interface WidgetSettings { left: WidgetId[]; right: WidgetId[] }
export const DEFAULT_WIDGETS: WidgetSettings = { left: ['clock', 'battery'], right: ['tripDist', 'avgSpeed', 'altitude'] };

export const widgets = {
  s: structuredClone(DEFAULT_WIDGETS),
  listeners: new Set<() => void>(),
  async load() { this.s = { ...DEFAULT_WIDGETS, ...(await getSetting('dailyWidgets', DEFAULT_WIDGETS)) }; },
  async save(s: WidgetSettings) { this.s = s; await putSetting('dailyWidgets', s); this.listeners.forEach((f) => f()); },
};

/** Live ride statistics for the widgets (reset when a ride starts). */
export const stats = {
  started: 0, distM: 0, movingS: 0, maxMps: 0, climbM: 0, alts: [] as number[],
  lastP: null as LngLat | null, lastT: 0, lastAlt: null as number | null,
  reset() { Object.assign(this, { started: Date.now(), distM: 0, movingS: 0, maxMps: 0, climbM: 0, alts: [], lastP: null, lastT: 0, lastAlt: null }); },
  update(p: LngLat, mps: number, alt: number | null) {
    const now = Date.now();
    if (this.lastP) {
      const d = haversine(this.lastP, p), dt = (now - this.lastT) / 1000;
      if (dt > 0 && d / dt < 70) { this.distM += d; if (mps > 1.5 && dt < 120) this.movingS += dt; }
    }
    this.maxMps = Math.max(this.maxMps, mps);
    if (alt !== null && Number.isFinite(alt)) {
      if (this.lastAlt !== null && alt - this.lastAlt > 2) this.climbM += alt - this.lastAlt;
      if (this.lastAlt === null || Math.abs(alt - this.lastAlt) > 2) this.lastAlt = alt;
      if (!this.alts.length || now - this.lastT > 20000 || this.alts.length < 2) this.alts.push(alt);
      if (this.alts.length > 240) this.alts.shift();
    }
    this.lastP = p; this.lastT = now;
  },
};

let wasOff = true;
nav.subscribe(() => {
  if (nav.mode === 'off') { wasOff = true; return; }
  if (wasOff) { stats.reset(); wasOff = false; }
  if (nav.pos) stats.update(nav.pos, nav.mode === 'sim' ? nav.settings.simKmh / 3.6 * nav.mult : nav.speedMps, nav.altitude);
});
