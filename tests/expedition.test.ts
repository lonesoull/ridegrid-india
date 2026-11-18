import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { RideDB, useDB, db } from '../src/core/db';
import { engine } from '../src/core/engine';
import { createTrip } from '../src/core/trips';
import { buildRouteLine, type RouteLine } from '../src/nav/routeLine';
import { SegIndex, isParallel } from '../src/nav/spatial';
import { checkRoute } from '../src/nav/checker';
import { deriveTurns, noGoPolygons, minGapAlong } from '../src/nav/detour';
import { BreakDetector, daySummaries } from '../src/nav/logbook';
import { haversine, type LngLat } from '../src/core/geo';

/** Build a RouteLine straight from coordinates (each point is a waypoint). */
async function lineFrom(pts: LngLat[], name: string): Promise<RouteLine> {
  useDB(new RideDB(name));
  const t = await createTrip(name, undefined, 'expedition');
  await engine.loadTrip(t.id);
  await engine.addMany(pts.map((p) => ({ p })));
  return buildRouteLine();
}
const M = 1 / 111320; // ~1 m in degrees of latitude

describe('spatial index', () => {
  it('finds the nearest other part of the route and honours skip ranges', async () => {
    // east 2 km, then north 500 m, then back west 2 km at 40 m separation (a parallel return road)
    const L = await lineFrom([[77, 20], [77.019, 20], [77.019, 20 + 40 * M], [77, 20 + 40 * M]], 'sp1');
    const idx = new SegIndex(L);
    const p: LngLat = [77.01, 20 + 20 * M]; // between the two parallel parts
    const n = idx.nearest(p, 100)!;
    expect(n.d).toBeGreaterThan(18); expect(n.d).toBeLessThan(22);
    const firstPartEnd = L.stopS[1];
    const n2 = idx.nearest(p, 100, [[0, firstPartEnd]])!;
    expect(n2.s).toBeGreaterThan(firstPartEnd);
    expect(isParallel(90, 270)).toBe(true);
    expect(isParallel(90, 0)).toBe(false);
  });
});

describe('route checker', () => {
  it('flags crossings, overlaps and parallel carriageways; passes a clean route', async () => {
    const clean = await lineFrom([[77, 20], [77.02, 20], [77.02, 20.02], [77.04, 20.02]], 'ck1');
    expect((await checkRoute(clean, { gapM: 30 })).issues.length).toBe(0);

    // figure: east, north, west back across the first part's start area, then south crossing it
    const cross = await lineFrom([[77, 20], [77.02, 20], [77.02, 20.01], [77.01, 20.01], [77.01, 19.99]], 'ck2');
    const r2 = await checkRoute(cross, { gapM: 30 });
    expect(r2.issues.some((x) => x.kind === 'crossing' || x.kind === 'close')).toBe(true);

    // return on a road 25 m away (other carriageway) → overlap/close; 60 m away → parallel
    const twin = await lineFrom([[77, 20], [77.02, 20], [77.02, 20 + 25 * M], [77, 20 + 25 * M]], 'ck3');
    const r3 = await checkRoute(twin, { gapM: 30 });
    expect(r3.issues.some((x) => x.kind === 'overlap')).toBe(true);
    const wide = await lineFrom([[77, 20], [77.02, 20], [77.02, 20 + 60 * M], [77, 20 + 60 * M]], 'ck4');
    const r4 = await checkRoute(wide, { gapM: 30 });
    expect(r4.issues.some((x) => x.kind === 'parallel')).toBe(true);
    expect(r4.issues.every((x) => x.kind === 'parallel')).toBe(true);
  });
});

describe('detour helpers', () => {
  it('derives turns from a GPS path', () => {
    const path: LngLat[] = [];
    for (let i = 0; i <= 10; i++) path.push([77 + i * 0.0002, 20]);      // east
    for (let i = 1; i <= 10; i++) path.push([77.002, 20 + i * 0.0002]); // then north = left turn
    const t = deriveTurns(path);
    expect(t.length).toBe(1);
    expect(t[0].c).toBe('left');
  });
  it('builds closed no-go strips around nearby planned roads and measures gaps', async () => {
    const L = await lineFrom([[77, 20], [77.02, 20], [77.02, 20.01], [77, 20.01]], 'ng1');
    const polys = noGoPolygons(L, [77.005, 20.005], [77.0, 20.0], [0, 100], 40);
    expect(polys.length).toBeGreaterThan(0);
    for (const r of polys) expect(r[0]).toEqual(r[r.length - 1]);
    const idx = new SegIndex(L);
    const gap = minGapAlong([[77.005, 20.005], [77.006, 20.005]], idx, [-1, -1], 2000);
    expect(gap).toBeGreaterThan(500);
  });
});

describe('logbook', () => {
  it('detects a break after standing still and closes it when moving on', async () => {
    useDB(new RideDB('lb1'));
    const t = await createTrip('LB', undefined, 'expedition');
    const bd = new BreakDetector(() => ({ tripId: t.id, minMinutes: 5 }));
    const t0 = Date.parse('2026-11-20T08:00:00+05:30');
    const here: LngLat = [77, 20];
    for (let m = 0; m <= 8; m++) await bd.onFix([here[0] + (m % 2) * 0.00005, here[1]], t0 + m * 60000, 0, 8); // ~5 m jitter
    expect(bd.current).not.toBeNull();
    await bd.onFix([77.002, 20], t0 + 10 * 60000, 10, 8); // rode off ~210 m
    const logs = await db.stopLogs.toArray();
    expect(logs.length).toBe(1);
    expect(logs[0].type).toBe('break');
    expect((logs[0].endAt! - logs[0].at) / 60000).toBeCloseTo(10, 0);
    const days = await daySummaries(t.id);
    expect(days[0].breaks).toBe(1);
  });
});
