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

describe('evidence checks', () => {
  it('flags GPS gaps, missing witnesses/evidence and a day not starting where the last ended', async () => {
    useDB(new RideDB('lb2'));
    const t = await createTrip('EV', undefined, 'expedition');
    const pts = (t0: number, from: LngLat, n: number, stepDeg: number) =>
      Array.from({ length: n }, (_, i) => [t0 + i * 10000, from[0] + i * stepDeg, from[1], 8, 15] as [number, number, number, number, number]);
    const d1 = Date.parse('2026-11-20T08:00:00+05:30'), d2 = Date.parse('2026-11-21T08:00:00+05:30');
    // day 1: ~2 h riding east (15 m/s), then a 20-min hole while moving 10 km, then more riding
    const a = pts(d1, [77, 20], 720, 0.0014);
    const last = a[a.length - 1];
    const b = pts(last[0] + 20 * 60000, [last[1] + 0.1, 20], 60, 0.0014);
    await db.rides.put({ id: 'r1', tripId: t.id, startedAt: d1, endedAt: b[b.length - 1][0], distM: 0, points: 0, simulated: false, name: 'r1' });
    await db.rideChunks.add({ rideId: 'r1', pts: [...a, ...b] });
    // day 2 starts 5 km away from where day 1 ended
    const c = pts(d2, [b[b.length - 1][1] + 0.05, 20], 60, 0.0014);
    await db.rides.put({ id: 'r2', tripId: t.id, startedAt: d2, endedAt: c[c.length - 1][0], distM: 0, points: 0, simulated: false, name: 'r2' });
    await db.rideChunks.add({ rideId: 'r2', pts: c });
    await db.stopLogs.put({ id: 'w', tripId: t.id, type: 'police', at: d2 + 60000, lng: c[5][1], lat: 20, witness: { name: 'SI Kumar', role: 'Sub-Inspector', independent: true } });
    const [day2, day1] = await daySummaries(t.id);
    expect(day1.gaps.length).toBe(1);
    expect(day1.gaps[0].km).toBeGreaterThan(9);
    expect(day1.km).toBeGreaterThan(100); // gap not counted: ~111 + ~9 km of real track
    expect(day1.km).toBeLessThan(125);
    expect(day1.issues.join('\n')).toMatch(/No witness/);
    expect(day1.issues.join('\n')).toMatch(/evidence photo/);
    expect(day1.issues.join('\n')).toMatch(/GPS not recording/);
    expect(day2.witnesses).toBe(1);
    expect(day2.startGapKm!).toBeGreaterThan(4);
    expect(day2.issues.join('\n')).toMatch(/continuous/);
    expect(day2.issues.join('\n')).not.toMatch(/No witness/);
  });
});
