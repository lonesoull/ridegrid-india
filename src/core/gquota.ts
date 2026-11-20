/**
 * Google Maps Platform usage counters with hard monthly caps (per device). Google's free allowance is per
 * account and shared by your 3 devices, so each device's default cap is a third of the India free amount.
 * When a cap is reached the feature quietly falls back to the app's own (free) version.
 */
export type Sku = 'mapLoad' | 'autocomplete' | 'placeBasic' | 'photo' | 'nearby' | 'streetView' | 'streetStatic' | 'routes2w' | 'routesTransit' | 'routesWalk'
  | 'matrix' | 'elevation' | 'weather' | 'airQuality' | 'pollen' | 'geocode' | 'snapRoads' | 'textAlongRoute';
export const SKU_INFO: Record<Sku, { label: string; level: 'Essentials' | 'Pro' | 'Enterprise'; free: number }> = {
  mapLoad: { label: 'Google map loads', level: 'Essentials', free: 70000 },
  autocomplete: { label: 'Search suggestions', level: 'Essentials', free: 70000 },
  placeBasic: { label: 'Place cards (basic)', level: 'Essentials', free: 70000 },
  photo: { label: 'Place photos', level: 'Enterprise', free: 7000 },
  nearby: { label: 'Explore nearby', level: 'Pro', free: 35000 },
  streetView: { label: 'Street View (interactive)', level: 'Pro', free: 35000 },
  streetStatic: { label: 'Street View photo', level: 'Essentials', free: 70000 },
  routes2w: { label: 'Two-wheeler routes & faster-route checks', level: 'Enterprise', free: 7000 },
  routesTransit: { label: 'Public transport routes', level: 'Pro', free: 35000 },
  routesWalk: { label: 'Walking routes', level: 'Essentials', free: 70000 },
  matrix: { label: 'Stop sorting (road times, per pair)', level: 'Enterprise', free: 7000 },
  elevation: { label: 'Elevation', level: 'Pro', free: 35000 },
  weather: { label: 'Weather', level: 'Essentials', free: 70000 },
  airQuality: { label: 'Air quality', level: 'Essentials', free: 70000 },
  pollen: { label: 'Pollen', level: 'Essentials', free: 70000 },
  geocode: { label: 'Address lookup', level: 'Essentials', free: 70000 },
  snapRoads: { label: 'Snap track to roads', level: 'Essentials', free: 70000 },
  textAlongRoute: { label: 'Search along route', level: 'Pro', free: 35000 },
};
/** The Enterprise SKUs share one budget in practice — keep them well inside 7,000 together. */
const DEVICES = 3;
const month = () => new Date().toISOString().slice(0, 7);
const K = 'ridegrid.gquota';
type Store = { month: string; used: Partial<Record<Sku, number>>; caps: Partial<Record<Sku, number>> };
function read(): Store {
  try { const s = JSON.parse(localStorage.getItem(K) ?? 'null') as Store | null; if (s) { if (s.month !== month()) { s.month = month(); s.used = {}; } return s; } } catch { /* ignore */ }
  return { month: month(), used: {}, caps: {} };
}
function write(s: Store) { try { localStorage.setItem(K, JSON.stringify(s)); } catch { /* private mode */ } }

export class QuotaError extends Error { constructor(public sku: Sku) { super(`Monthly limit reached for ${SKU_INFO[sku].label} — using the free version`); } }

export const gquota = {
  listeners: new Set<() => void>(),
  cap(sku: Sku) { return read().caps[sku] ?? Math.floor(SKU_INFO[sku].free / DEVICES); },
  used(sku: Sku) { return read().used[sku] ?? 0; },
  /** Is there room for n more uses? */
  can(sku: Sku, n = 1) { return this.used(sku) + n <= this.cap(sku); },
  /** Count n uses; throws QuotaError when that would pass the cap. */
  take(sku: Sku, n = 1) {
    const s = read();
    const u = (s.used[sku] ?? 0) + n;
    if (u > (s.caps[sku] ?? Math.floor(SKU_INFO[sku].free / DEVICES))) throw new QuotaError(sku);
    s.used[sku] = u; write(s); this.listeners.forEach((f) => f());
  },
  setCap(sku: Sku, cap: number) { const s = read(); s.caps[sku] = Math.max(0, Math.round(cap)); write(s); this.listeners.forEach((f) => f()); },
  all() { const s = read(); return (Object.keys(SKU_INFO) as Sku[]).map((k) => ({ sku: k, ...SKU_INFO[k], used: s.used[k] ?? 0, cap: s.caps[k] ?? Math.floor(SKU_INFO[k].free / DEVICES) })); },
};
