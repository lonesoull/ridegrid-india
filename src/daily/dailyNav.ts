import { getSetting, putSetting } from '../core/db';
import { engine, legCache } from '../core/engine';
import { routing, type DailyRouteOpts } from '../core/router';
import type { LngLat } from '../core/geo';
import { voiceHook } from '../nav/audio';
import { translate } from './voice';

/** Daily ride navigation settings (OsmAnd "Navigation settings" / "Route parameters"). */
export interface AvoidedRoad { id: string; name: string; coords: LngLat[]; at: number }
export type VoiceLang = 'en-IN' | 'hi-IN' | 'ta-IN' | 'te-IN' | 'kn-IN' | 'ml-IN' | 'mr-IN' | 'bn-IN';
export interface DailyNavSettings {
  route: DailyRouteOpts;
  avoided: AvoidedRoad[];
  voice: VoiceLang;
  autoZoom: boolean;
  alerts: { camera: boolean; bump: boolean; rail: boolean; toll: boolean; signals: boolean; zebra: boolean; stop: boolean; hazard: boolean; speed: boolean };
  speedTolerance: number; // km/h over the posted limit before the warning
  /** announce places ahead on the route (OsmAnd "Announce POIs / favourites") */
  ahead: { fuel: boolean; favourites: boolean; food: boolean; mechanic: boolean };
}
export const DEFAULT_DAILY_NAV: DailyNavSettings = {
  route: { avoidToll: false, avoidFerry: false, avoidUnpaved: false, avoidMotorway: false, shortest: false },
  avoided: [], voice: 'en-IN', autoZoom: true,
  alerts: { camera: true, bump: true, rail: true, toll: true, signals: false, zebra: false, stop: false, hazard: true, speed: true },
  speedTolerance: 5,
  ahead: { fuel: true, favourites: true, food: false, mechanic: false },
};

const isDaily = () => engine.trip?.kind === 'daily';

export const dailyNav = {
  s: structuredClone(DEFAULT_DAILY_NAV),
  listeners: new Set<() => void>(),
  async load() {
    const v = await getSetting<Partial<DailyNavSettings>>('dailyNav', {});
    this.s = { ...DEFAULT_DAILY_NAV, ...v, route: { ...DEFAULT_DAILY_NAV.route, ...v.route }, alerts: { ...DEFAULT_DAILY_NAV.alerts, ...v.alerts }, ahead: { ...DEFAULT_DAILY_NAV.ahead, ...v.ahead } };
    routing.dailyOpts = () => (isDaily() ? this.s.route : null);
    routing.avoidSegs = () => (isDaily() && this.s.avoided.length ? segsOf(this.s.avoided) : undefined);
    legCache.tag = () => (isDaily() ? this.tag() : '');
    voiceHook.lang = () => (isDaily() ? this.s.voice : 'en-IN');
    voiceHook.tr = (t) => (isDaily() && this.s.voice !== 'en-IN' ? translate(t, this.s.voice) : t);
  },
  /** Cache namespace for Daily routes: changes when route options or avoided roads change. */
  tag() {
    const r = this.s.route;
    // Google-planned legs are cached apart: they may only be shown on the Google map
    const g = routing.preferGoogle?.() ? 'g' : '';
    return `d${g}${+r.avoidToll}${+r.avoidFerry}${+r.avoidUnpaved}${+r.avoidMotorway}${+r.shortest}${this.s.avoided.length ? ':' + this.s.avoided.map((a) => a.id).sort().join(',') : ''}|`;
  },
  async save(p: Partial<DailyNavSettings>) {
    const before = this.tag();
    this.s = { ...this.s, ...p };
    await putSetting('dailyNav', this.s);
    this.listeners.forEach((f) => f());
    // route options changed: reload the trip so every leg is looked up / routed again with the new options
    if (isDaily() && engine.trip && this.tag() !== before) await engine.loadTrip(engine.trip.id);
  },
};

let segCache: { ids: string; segs: number[] } | null = null;
function segsOf(list: AvoidedRoad[]) {
  const ids = list.map((a) => a.id).join(',');
  if (segCache?.ids === ids) return segCache.segs;
  const segs: number[] = [];
  for (const a of list) for (let i = 0; i < a.coords.length - 1; i++) segs.push(a.coords[i][0], a.coords[i][1], a.coords[i + 1][0], a.coords[i + 1][1]);
  segCache = { ids, segs };
  return segs;
}
