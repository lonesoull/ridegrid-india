import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { RideDB, useDB, db } from '../src/core/db';
import { engine } from '../src/core/engine';
import { createTrip } from '../src/core/trips';
import { RoutingQueue, type Provider } from '../src/core/router';
import type { LngLat } from '../src/core/geo';

let n = 0;
beforeEach(async () => {
  useDB(new RideDB('t' + n++));
  const t = await createTrip('Test');
  await engine.loadTrip(t.id);
});

const pts = (k: number, off = 0): { p: LngLat }[] => Array.from({ length: k }, (_, i) => ({ p: [77 + (i + off) * 0.01, 28] as LngLat }));

describe('engine', () => {
  it('adds stops and creates one leg per consecutive pair', async () => {
    await engine.addMany(pts(5));
    expect(engine.stops.length).toBe(5);
    expect(engine.legs.size).toBe(4);
    expect(engine.pendingLegs).toBe(4);
  });

  it('move only replaces the two adjacent legs', async () => {
    await engine.addMany(pts(6));
    const before = new Set(engine.legs.keys());
    await engine.moveStop(engine.stops[2].id, [77.5, 28.5]);
    const after = new Set(engine.legs.keys());
    const removed = [...before].filter((k) => !after.has(k));
    const added = [...after].filter((k) => !before.has(k));
    expect(removed.length).toBe(2);
    expect(added.length).toBe(2);
    expect(engine.legs.size).toBe(5);
  });

  it('delete bridges N-1 → N+1 and insert splits a leg', async () => {
    await engine.addMany(pts(4));
    const [a, b, c] = engine.stops;
    await engine.deleteStop(b.id);
    expect(engine.legs.size).toBe(2);
    expect([...engine.legs.values()].some((l) => l.a === a.id && l.b === c.id)).toBe(true);
    const leg = [...engine.legs.values()].find((l) => l.a === a.id)!;
    await engine.insertOnLeg(leg.key, [77.005, 28.001]);
    expect(engine.stops[1].lng).toBeCloseTo(77.005);
    expect(engine.legs.size).toBe(3);
  });

  it('undo/redo are disk backed and survive reload', async () => {
    await engine.addMany(pts(3));
    await engine.addStop([78, 28]);
    await engine.deleteAt(0);
    expect(engine.stops.length).toBe(3);
    await engine.undo();
    expect(engine.stops.length).toBe(4);
    await engine.undo();
    expect(engine.stops.length).toBe(3);
    await engine.flush();
    await engine.loadTrip(engine.trip!.id); // simulate app restart
    expect(engine.stops.length).toBe(3);
    expect(engine.canRedo).toBe(true);
    await engine.redo();
    expect(engine.stops.length).toBe(4);
    await engine.redo();
    expect(engine.stops.length).toBe(3);
    // a new edit after undo truncates the redo branch
    await engine.undo();
    await engine.addStop([79, 28]);
    expect(engine.canRedo).toBe(false);
    expect(await db.history.count()).toBe(3);
  });

  it('reverse respects sequence lock', async () => {
    await engine.addMany(pts(3));
    await expect(engine.reverse()).rejects.toThrow(/Sequence Lock/);
    await engine.updateTrip({ sequenceLock: false });
    const first = engine.stops[0].id;
    await engine.reverse();
    expect(engine.stops[2].id).toBe(first);
  });

  it('routing queue batches, caches legs, and never refetches cached legs', async () => {
    let calls = 0;
    const fake: Provider = {
      id: 'fake', label: 'fake', maxWaypoints: 4, minIntervalMs: 0,
      async route(points) { calls++; return points.slice(1).map((p, i) => ({ coords: [points[i], [(p[0] + points[i][0]) / 2, 28.0001], p], distM: 1000 })); },
      async nearest() { return null; },
    };
    const q = new RoutingQueue(fake, engine);
    await engine.addMany(pts(7)); // 6 legs → 2 requests of 3 legs
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.pendingLegs).toBe(0);
    expect(calls).toBe(2);
    expect(Math.round(engine.routedM)).toBe(6000);
    // same coordinates in a fresh trip → served from IndexedDB cache, zero new requests
    const t2 = await createTrip('Second');
    await engine.loadTrip(t2.id);
    await engine.addMany(pts(7));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
    expect(engine.pendingLegs).toBe(0);
    q.setAuto(false);
  });

  it('handles 100k stops quickly', async () => {
    const t0 = performance.now();
    await engine.addMany(Array.from({ length: 100000 }, (_, i) => ({ p: [70 + (i % 300) * 0.05, 10 + Math.floor(i / 300) * 0.05] as LngLat })));
    const t1 = performance.now();
    expect(engine.legs.size).toBe(99999);
    await engine.moveStop(engine.stops[50000].id, [80, 20]);
    const t2 = performance.now();
    await engine.deleteAt(60000);
    const t3 = performance.now();
    console.log(`100k add ${(t1 - t0).toFixed(0)}ms, move ${(t2 - t1).toFixed(1)}ms, delete ${(t3 - t2).toFixed(1)}ms`);
    expect(engine.legs.size).toBe(99998);
  }, 60000);
});

describe('crash safety', () => {
  it('replays edits whose draft snapshot was never written', async () => {
    await engine.addMany(pts(3));            // never flushed: snapshot is still the empty one from createTrip
    await engine.addStop([78, 28]);
    await engine.deleteAt(0);
    await engine.undo();
    // simulate closing the tab before the 600 ms snapshot timer fires
    (engine as any).saveTimer && clearTimeout((engine as any).saveTimer);
    (engine as any).saveTimer = null;
    const id = engine.trip!.id;
    (engine as any).trip = null;
    await engine.loadTrip(id);
    expect(engine.stops.length).toBe(4);
    await engine.undo();
    expect(engine.stops.length).toBe(3);
  });
});
