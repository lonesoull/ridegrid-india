import type { LngLat } from '../core/geo';
import type { Provider, LegResult } from '../core/router';
import { routing } from '../core/router';
import type { Turn, TurnCode } from '../core/turns';

/** Extra Daily-only routing engines (OsmAnd lets you pick online routers too): GraphHopper and OpenRouteService.
 *  They work only for Daily trips (ids start with "daily:"), with the rider's own free keys. Expedition never uses them. */
const ls = (k: string, v?: string) => { try { if (v === undefined) return localStorage.getItem(k) ?? ''; localStorage.setItem(k, v); } catch { /* ignore */ } return v ?? ''; };
export const engines = {
  get ghKey() { return ls('ridegrid.engine.gh'); }, set ghKey(v: string) { ls('ridegrid.engine.gh', v.trim()); },
  get orsKey() { return ls('ridegrid.engine.ors'); }, set orsKey(v: string) { ls('ridegrid.engine.ors', v.trim()); },
};
const GH: Record<number, TurnCode> = { [-3]: 'sharp-left', [-2]: 'left', [-1]: 'slight-left', 0: 'straight', 1: 'slight-right', 2: 'right', 3: 'sharp-right', 6: 'roundabout', [-7]: 'keep-left', 7: 'keep-right', [-98]: 'uturn', 8: 'uturn' };
const ORS: Record<number, TurnCode> = { 0: 'left', 1: 'right', 2: 'sharp-left', 3: 'sharp-right', 4: 'slight-left', 5: 'slight-right', 6: 'straight', 7: 'roundabout', 9: 'uturn', 12: 'keep-left', 13: 'keep-right' };
const nearest = async () => null;

export function graphhopperProvider(): Provider {
  return {
    id: 'daily:graphhopper', label: 'GraphHopper (scooter)', maxWaypoints: 2, minIntervalMs: 1200, nearest,
    async route(points: LngLat[], signal: AbortSignal): Promise<LegResult[]> {
      const d = routing.dailyOpts?.();
      const body = { points, profile: 'scooter', points_encoded: false, instructions: true, locale: 'en', ...(d?.avoidFerry || d?.avoidToll || d?.avoidMotorway ? { 'ch.disable': true, custom_model: { priority: [
        ...(d.avoidFerry ? [{ if: 'road_environment == FERRY', multiply_by: '0' }] : []), ...(d.avoidToll ? [{ if: 'toll != NO', multiply_by: '0.05' }] : []), ...(d.avoidMotorway ? [{ if: 'road_class == MOTORWAY', multiply_by: '0' }] : []) ] } } : {}) };
      const r = await fetch(`https://graphhopper.com/api/1/route?key=${encodeURIComponent(engines.ghKey)}`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.paths?.[0]) throw new Error(j.message ?? `GraphHopper ${r.status}`);
      const p = j.paths[0];
      const turns: Turn[] = (p.instructions ?? []).filter((x: any) => GH[x.sign] && x.sign !== 0).map((x: any) => ({ i: x.interval[0], c: GH[x.sign], n: x.street_name || undefined, ...(x.sign === 6 && x.exit_number ? { x: x.exit_number } : {}) }));
      return [{ coords: p.points.coordinates.map((c: number[]) => [c[0], c[1]] as LngLat), distM: p.distance, turns }];
    },
  };
}

export function orsProvider(): Provider {
  return {
    id: 'daily:ors', label: 'OpenRouteService', maxWaypoints: 25, minIntervalMs: 1600, nearest,
    async route(points: LngLat[], signal: AbortSignal): Promise<LegResult[]> {
      const d = routing.dailyOpts?.();
      const avoid = [d?.avoidMotorway && 'highways', d?.avoidToll && 'tollways', d?.avoidFerry && 'ferries'].filter(Boolean);
      const body = { coordinates: points, instructions: true, ...(d?.shortest ? { preference: 'shortest' } : {}), ...(avoid.length ? { options: { avoid_features: avoid } } : {}) };
      const r = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: engines.orsKey }, body: JSON.stringify(body) });
      const j = await r.json();
      const f = j.features?.[0];
      if (!r.ok || !f) throw new Error(j.error?.message ?? `OpenRouteService ${r.status}`);
      const all: LngLat[] = f.geometry.coordinates.map((c: number[]) => [c[0], c[1]] as LngLat);
      const wp: number[] = f.properties.way_points;
      return f.properties.segments.map((s: any, k: number) => {
        const a = wp[k], b = wp[k + 1];
        const turns: Turn[] = (s.steps ?? []).filter((x: any) => ORS[x.type] && x.type !== 6).map((x: any) => ({ i: x.way_points[0] - a, c: ORS[x.type], n: x.name && x.name !== '-' ? x.name : undefined, ...(x.exit_number ? { x: x.exit_number } : {}) }));
        return { coords: all.slice(a, b + 1), distM: s.distance, turns };
      });
    },
  };
}

/** Engines with a key saved, for the routing queue. */
export const extraEngines = (): Provider[] => [...(engines.ghKey ? [graphhopperProvider()] : []), ...(engines.orsKey ? [orsProvider()] : [])];
