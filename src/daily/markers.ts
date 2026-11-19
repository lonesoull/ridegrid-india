import { db, uid, type MyPlace } from '../core/db';
import type { LngLat } from '../core/geo';

/** Daily "My places": favourites (with groups), map markers, parked bike, geo-notes. */
export const MARKER_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fb8c00', '#8e24aa', '#00897b', '#6d4c41'];

let cache: MyPlace[] = [];
export const markers = {
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  async load() { cache = await db.myplaces.toArray(); this.emit(); },
  all() { return cache; },
  favourites() { return cache.filter((x) => x.kind === 'fav'); },
  groups() { return [...new Set(this.favourites().map((x) => x.group || 'Favourites'))].sort(); },
  active() { return cache.filter((x) => x.kind === 'marker' && x.active !== false).sort((a, b) => a.at - b.at); },
  parking() { return cache.find((x) => x.kind === 'parking') ?? null; },
  notes() { return cache.filter((x) => x.kind === 'note').sort((a, b) => b.at - a.at); },
  async put(x: Omit<MyPlace, 'id' | 'at'> & { id?: string; at?: number }) {
    const v: MyPlace = { ...x, id: x.id ?? uid(), at: x.at ?? Date.now() } as MyPlace;
    if (v.kind === 'parking') for (const o of cache.filter((c) => c.kind === 'parking' && c.id !== v.id)) await db.myplaces.delete(o.id); // only one parked bike
    if (v.kind === 'marker' && !v.color) v.color = MARKER_COLORS[this.active().length % MARKER_COLORS.length];
    await db.myplaces.put(v);
    await this.load();
    return v;
  },
  async remove(id: string) { await db.myplaces.delete(id); await this.load(); },
  async update(id: string, patch: Partial<MyPlace>) { await db.myplaces.update(id, patch); await this.load(); },
  /** GeoJSON of everything to draw on the map. */
  geojson(): GeoJSON.FeatureCollection {
    return { type: 'FeatureCollection', features: cache.filter((x) => x.kind !== 'marker' || x.active !== false).map((x) => ({
      type: 'Feature', properties: { id: x.id, kind: x.kind, name: x.name, color: x.color ?? (x.kind === 'parking' ? '#1565c0' : x.kind === 'note' ? '#6a1b9a' : '#f9a825'), icon: x.icon ?? (x.kind === 'parking' ? 'P' : x.kind === 'note' ? '✎' : x.kind === 'marker' ? '⚑' : '★') },
      geometry: { type: 'Point', coordinates: x.p as LngLat },
    })) };
  },
};
