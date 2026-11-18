import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { RideDB, useDB } from '../src/core/db';
import { engine } from '../src/core/engine';
import { createTrip } from '../src/core/trips';
import { buildRouteLine, matchToRoute, pointAt, sliceLine } from '../src/nav/routeLine';
import { stage, stageCount, stagesCSV } from '../src/nav/gmaps';
import { haversine, type LngLat } from '../src/core/geo';

beforeAll(async () => {
  useDB(new RideDB('nav'));
  const t = await createTrip('Nav');
  await engine.loadTrip(t.id);
  // 25 stops ~1.1 km apart going east along latitude 20
  await engine.addMany(Array.from({ length: 25 }, (_, i) => ({ p: [78 + i * 0.01, 20] as LngLat })));
});

describe('route line', () => {
  it('builds a continuous line with stop positions', () => {
    const L = buildRouteLine();
    expect(L.stopS.length).toBe(25);
    expect(L.stopS[0]).toBe(0);
    expect(L.total).toBeGreaterThan(25000);
    expect(L.stopS[24]).toBeCloseTo(L.total, 3);
    for (let i = 1; i < 25; i++) expect(L.stopS[i]).toBeGreaterThan(L.stopS[i - 1]);
  });
  it('pointAt interpolates and gives an east heading', () => {
    const L = buildRouteLine();
    const a = pointAt(L, L.stopS[5]);
    expect(haversine(a.p, [78.05, 20])).toBeLessThan(1);
    expect(a.heading).toBeGreaterThan(85); expect(a.heading).toBeLessThan(95);
    expect(sliceLine(L, 0, L.stopS[3]).length).toBeGreaterThanOrEqual(2);
  });
  it('matches a GPS point 40 m off the road to the right place', () => {
    const L = buildRouteLine();
    const m = matchToRoute(L, [78.123, 20.00036], 0);
    expect(m.d).toBeGreaterThan(35); expect(m.d).toBeLessThan(45);
    expect(Math.abs(m.s - haversine([78, 20], [78.123, 20]))).toBeLessThan(5);
  });
});

describe('google maps stages', () => {
  it('splits 25 stops into 3 stages of up to 10 legs that share endpoints', () => {
    expect(stageCount()).toBe(3);
    const s1 = stage(0)!, s2 = stage(1)!, s3 = stage(2)!;
    expect([s1.from, s1.to, s2.from, s2.to, s3.from, s3.to]).toEqual([0, 10, 10, 20, 20, 24]);
    const u = new URL(s1.url);
    expect(u.searchParams.get('travelmode')).toBe('two-wheeler');
    expect(u.searchParams.get('origin')).toBe('20.000000,78.000000');
    expect(u.searchParams.get('waypoints')!.split('|').length).toBe(9);
    expect(stagesCSV().split('\n').length).toBe(4);
  });
});
