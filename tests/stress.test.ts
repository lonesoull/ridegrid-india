import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { RideDB, useDB, db } from '../src/core/db';
import { engine } from '../src/core/engine';
import { app } from '../src/core/app';
import * as trips from '../src/core/trips';
import { inIndia, stressWalk } from '../src/core/india';

describe('stress test sandbox', () => {
  it('outline sanity: Indian cities in, neighbours out', () => {
    for (const p of [[77.21, 28.61], [72.88, 19.08], [80.27, 13.08], [88.36, 22.57], [91.74, 26.14], [77.59, 12.97], [76.95, 8.52]] as [number, number][]) expect(inIndia(p)).toBe(true);
    for (const p of [[90.41, 23.81], [85.32, 27.72], [96.15, 16.87], [100.5, 13.75], [67.0, 24.86], [80.0, 7.0]] as [number, number][]) expect(inIndia(p)).toBe(false);
  });

  it('walk never leaves India', () => {
    const pts = stressWalk(20000);
    expect(pts.every(inIndia)).toBe(true);
  });

  it('uses a separate trip, never routes it, and clear-all returns to the real trip', async () => {
    useDB(new RideDB('stress'));
    const real = await trips.createTrip('Real');
    await trips.switchTrip(real.id);
    await engine.addStop([77.2, 28.6]);
    expect(app.queue.autoRoute).toBe(true);

    await trips.addStressStops(1000);
    expect(engine.trip!.isStress).toBe(true);
    expect(engine.stops.length).toBe(1000);
    expect(app.queue.autoRoute).toBe(false);

    await trips.leaveStressTrip();
    expect(engine.trip!.id).toBe(real.id);
    expect(engine.stops.length).toBe(1);
    expect(app.queue.autoRoute).toBe(true);

    await trips.addStressStops(100); // re-uses the same stress trip
    expect(engine.stops.length).toBe(1100);
    await trips.deleteStressTrip();
    expect(engine.trip!.id).toBe(real.id);
    expect((await db.trips.toArray()).some((t) => t.isStress)).toBe(false);
    expect(await db.history.where('tripId').notEqual(real.id).count()).toBe(0);
    app.queue.setAuto(false);
  });
});
