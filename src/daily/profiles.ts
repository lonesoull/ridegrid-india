import { db, getSetting, putSetting, uid } from '../core/db';
import { dailyNav } from './dailyNav';
import { dailyMap } from './mapLayers';
import { widgets } from './widgets';
import { quick } from './QuickActions';
import { sensors } from './sensors';

/**
 * Bike profiles (OsmAnd "Profiles"): each bike has its own route options, map, widgets and buttons,
 * plus fuel range and service reminders.
 */
export interface Bike {
  id: string; name: string; model?: string; reg?: string;
  tankL: number; kmpl: number; fuelLeftL: number; fuelAt: number; // fuel range: litres after the last fill, and when
  serviceEveryKm: number; lastServiceAt: number; wheelMm: number;
  snapshot?: Record<string, unknown>;
}
const NEW_BIKE = (): Bike => ({ id: uid(), name: 'My bike', tankL: 13, kmpl: 35, fuelLeftL: 13, fuelAt: Date.now(), serviceEveryKm: 3000, lastServiceAt: Date.now(), wheelMm: 2050 });

export const bikes = {
  list: [] as Bike[], activeId: '',
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  get active(): Bike { return this.list.find((b) => b.id === this.activeId) ?? this.list[0]; },
  async load() {
    this.list = await getSetting<Bike[]>('bikes', []);
    if (!this.list.length) this.list = [NEW_BIKE()];
    this.activeId = await getSetting('activeBike', this.list[0].id);
    sensors.wheelMm = this.active.wheelMm;
  },
  async save() { await putSetting('bikes', this.list); await putSetting('activeBike', this.activeId); this.emit(); },
  async update(p: Partial<Bike>) { Object.assign(this.active, p); if (p.wheelMm) sensors.wheelMm = p.wheelMm; await this.save(); },
  async add(name: string) { const b = { ...NEW_BIKE(), name }; this.list.push(b); await this.save(); return b; },
  async remove(id: string) { if (this.list.length < 2) return; this.list = this.list.filter((b) => b.id !== id); if (this.activeId === id) this.activeId = this.list[0].id; await this.save(); },
  /** Switch bike: remember this bike's settings, load the other bike's. */
  async switchTo(id: string) {
    if (id === this.activeId) return;
    this.active.snapshot = { nav: dailyNav.s, map: dailyMap.settings, widgets: widgets.s, quick: quick.list };
    this.activeId = id;
    const s = this.active.snapshot as any;
    if (s) { await dailyNav.save(s.nav); await dailyMap.save(s.map); await widgets.save(s.widgets); await quick.save(s.quick); }
    sensors.wheelMm = this.active.wheelMm;
    await this.save();
  },
  /** km ridden in Daily mode since a time (rides + recordings). */
  async kmSince(t: number) {
    const daily = new Set((await db.trips.toArray()).filter((x) => x.kind === 'daily').map((x) => x.id));
    return (await db.rides.toArray()).filter((r) => daily.has(r.tripId) && !r.simulated && r.startedAt >= t).reduce((m, r) => m + r.distM, 0) / 1000;
  },
};

let rangeCache = { at: 0, km: NaN, serviceLeft: NaN };
/** Fuel range (km) and km to the next service, refreshed every minute. */
export async function bikeStatus() {
  if (Date.now() - rangeCache.at > 60000) {
    const b = bikes.active;
    const used = await bikes.kmSince(b.fuelAt), sinceService = await bikes.kmSince(b.lastServiceAt);
    rangeCache = { at: Date.now(), km: Math.max(0, b.fuelLeftL * b.kmpl - used), serviceLeft: b.serviceEveryKm - sinceService };
  }
  return rangeCache;
}
export const resetBikeStatus = () => { rangeCache.at = 0; };
