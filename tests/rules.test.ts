import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { RideDB, useDB } from '../src/core/db';
import { engine } from '../src/core/engine';
import { createTrip } from '../src/core/trips';
import { buildRouteLine } from '../src/nav/routeLine';
import { routeOnExpressways, loadExpressways } from '../src/nav/expressways';
import { deadEndSpurs } from '../src/nav/checker';
import type { LngLat } from '../src/core/geo';

// a fake "Yamuna Expressway" running east–west along latitude 27.5 from 77.6 to 77.7
const fc = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { n: 'Yamuna Expressway', r: '', h: 'motorway', mc: 'no' }, geometry: { type: 'LineString', coordinates: [[77.6, 27.5], [77.65, 27.5], [77.7, 27.5]] } }] };
let compliance: typeof import('../src/nav/compliance').compliance;
beforeAll(async () => {
  // the monitor pulls in browser-only helpers (wake lock, audio); a minimal document is enough here
  vi.stubGlobal('document', { addEventListener() {}, visibilityState: 'visible' });
  compliance = (await import('../src/nav/compliance')).compliance;
  vi.stubGlobal('fetch', async (url: string) => (String(url).includes('expressways.json') ? new Response(JSON.stringify(fc)) : new Response('', { status: 404 })));
});

async function routeFrom(pts: LngLat[], name: string) {
  useDB(new RideDB(name));
  const t = await createTrip(name, undefined, 'expedition');
  await engine.loadTrip(t.id);
  await engine.addMany(pts.map((p) => ({ p })));
  return buildRouteLine();
}

describe('expressway blocker', () => {
  it('flags a route that runs along a banned expressway, not one that merely crosses it', async () => {
    const along = await routeFrom([[77.6, 27.5], [77.7, 27.5]], 'ex1');
    const r1 = await routeOnExpressways(along);
    expect(r1!.length).toBe(1);
    expect(r1![0].road.name).toBe('Yamuna Expressway');
    expect(r1![0].s1End - r1![0].s1).toBeGreaterThan(9000);
    const across = await routeFrom([[77.65, 27.45], [77.65, 27.55]], 'ex2');
    expect((await routeOnExpressways(across))!.length).toBe(0);
  });
  it('live alarm when riding on it (same direction, moving)', async () => {
    expect(await loadExpressways()).not.toBeNull();
    await compliance.onPosition([77.66, 27.50001], 20, 90);
    expect(compliance.alerts.get('expressway')?.level).toBe('danger');
    await new Promise((r) => setTimeout(r, 950));
    await compliance.onPosition([77.66, 27.52], 20, 90); // 2 km away
    expect(compliance.alerts.has('expressway')).toBe(false);
  });
});

describe('48-hour halt timer', () => {
  it('counts down while within the radius and resets after moving away', () => {
    compliance.halt = { c: [77, 20], since: Date.now() - 47.5 * 3600e3 };
    compliance.updateHalt([77.001, 20.001]); // ~150 m away: still halted
    const left = compliance.haltLeftS!;
    expect(left).toBeGreaterThan(0.4 * 3600); expect(left).toBeLessThan(0.6 * 3600);
    compliance.updateHalt([77.2, 20]); // 20 km away: new place
    expect(compliance.haltLeftS).toBeNull();
  });
});

describe('speed monitor', () => {
  it('alerts above the limit after 5 s, not for brief spikes', async () => {
    useDB(new RideDB('sp'));
    compliance.alerts.clear();
    await compliance.onPosition([78, 21], 20, 0); // 72 km/h > 60 (+3 tolerance) — just started
    expect(compliance.alerts.has('speed')).toBe(false);
    (compliance as any).overSince = Date.now() - 6000;
    (compliance as any).lastCheck = 0;
    await compliance.onPosition([78, 21.0001], 20, 0);
    expect(compliance.alerts.get('speed')?.text).toMatch(/72 km\/h — limit 60/);
  });
});

describe('dead-end spur detector', () => {
  it('finds a U-turn in the planned geometry', async () => {
    const L = await routeFrom([[78, 21], [78.01, 21], [78.0, 21.0000001]], 'spur');
    expect(deadEndSpurs(L).length).toBeGreaterThan(0);
  });
});
