import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { RideDB, useDB } from '../src/core/db';
import { engine } from '../src/core/engine';
import { bootTrips, switchMode, listModeTrips, createTrip, switchTrip } from '../src/core/trips';
import { mode } from '../src/core/mode';

describe('Expedition / Daily modes', () => {
  it('keep their own trips and remember the last one of each', async () => {
    useDB(new RideDB('mode1'));
    await bootTrips();
    expect(mode.chosen).toBe(false);
    expect(engine.trip!.kind).toBe('expedition');
    const exp2 = await createTrip('Second expedition', undefined, 'expedition');
    await switchTrip(exp2.id);
    await switchMode('daily');
    expect(mode.current).toBe('daily');
    expect(engine.trip!.kind).toBe('daily');
    expect((await listModeTrips()).every((t) => t.kind === 'daily')).toBe(true);
    await switchMode('expedition');
    expect(engine.trip!.id).toBe(exp2.id); // back to the trip last open in this mode
    expect((await listModeTrips()).map((t) => t.name).sort()).toEqual(['My India Expedition', 'Second expedition']);
  });
  it('opening a trip of the other kind switches mode', async () => {
    useDB(new RideDB('mode2'));
    await bootTrips();
    const d = await createTrip('Pushed daily ride', undefined, 'daily');
    await switchTrip(d.id);
    expect(mode.current).toBe('daily');
  });
});
