import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Graph, route, routeMulti, linkGraphs, unlinkGraph } from '../src/route/graph';

// tests/fixtures/test.rgg = 3×3 grid around (80.00–80.02, 13.00–13.02):
//   row 13.00: Beach Road (NH 32, primary) 1-2-3 ;  column 80.00: West Rd 1-4-7 ;  column 80.01: 2nd Street 2-5-8
//   row 13.01: One Way Rd 4→5→6 (one-way east) ;  row 13.02: motorway 7-8-9 (removed) ;  3-6 private (removed)
const buf = readFileSync(new URL('./fixtures/test.rgg', import.meta.url));
const g = new Graph(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const near = (p: number[], q: number[]) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;

describe('on-device road graph', () => {
  it('loads the binary graph', () => {
    expect(g.V).toBe(8);
    expect(g.U).toBe(8);
    expect(g.names).toContain('NH 32 · Beach Road');
  });
  it('routes along roads (no straight lines) and names them', () => {
    const r = route(g, [80.0, 13.0], [80.01, 13.02])!; // 1 → 8
    expect(r).not.toBeNull();
    expect(r.distM).toBeGreaterThan(3000); // must go along the grid, not diagonally (2.4 km)
    expect(r.coords.some((c) => near(c, [80.01, 13.0]) || near(c, [80.0, 13.01]))).toBe(true);
  });
  it('respects one-way streets', () => {
    const fwd = route(g, [80.0, 13.01], [80.02, 13.01])!; // along One Way Rd eastwards: direct
    expect(fwd.distM).toBeLessThan(2300);
    const back = route(g, [80.02, 13.01], [80.0, 13.01]); // westwards: not allowed; 6 has no other open road
    expect(back === null || back.distM > 2300).toBe(true);
  });
  it('never uses removed roads (banned motorway, private road)', () => {
    const r = route(g, [80.0, 13.02], [80.01, 13.02])!; // 7 → 8: the motorway between them was removed
    expect(r.distM).toBeGreaterThan(3000);
    expect(r.names.every((n) => !/Expressway/.test(n ?? ''))).toBe(true);
  });
  it('snaps points that are slightly off the road', () => {
    const s = g.snap([80.005, 13.0003])!;
    expect(s.d).toBeLessThan(40);
    expect(g.names[g.name[s.e]]).toMatch(/Beach Road/);
  });
});

// two neighbouring "regions" that share the border junctions at lon 80.01 (like Geofabrik zones):
//   west: 1(80.00,13.00) 2(80.01,13.00) 4(80.00,13.01) 5(80.01,13.01) ;  east: 2 3(80.02,13.00) 5 6(80.02,13.01)
const ld = (f: string) => { const b = readFileSync(new URL(`./fixtures/${f}`, import.meta.url)); return new Graph(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };

describe('routing across downloaded regions', () => {
  it('finds the shared border junctions', () => {
    const w = ld('test-west.rgg'), e = ld('test-east.rgg');
    expect(linkGraphs(w, e)).toBe(2);
  });
  it('routes from one region into the next, both ways, along roads', () => {
    const w = ld('test-west.rgg'), e = ld('test-east.rgg');
    expect(routeMulti([w], [80.0, 13.0], [80.02, 13.01])).toBeNull(); // west alone has no road near 6
    linkGraphs(w, e);
    const r = routeMulti([w, e], [80.0, 13.0], [80.02, 13.01])!;
    expect(r).not.toBeNull();
    expect(r.distM).toBeGreaterThan(3200); // two grid sides ≈ 2.17 + 1.11 km, not the 2.4 km diagonal
    expect(r.distM).toBeLessThan(3400);
    expect(r.coords.some((c) => near(c, [80.01, 13.0]) || near(c, [80.01, 13.01]))).toBe(true);
    const back = routeMulti([e, w], [80.02, 13.01], [80.0, 13.0])!;
    expect(Math.abs(back.distM - r.distM)).toBeLessThan(5);
  });
  it('forgets a region when it is removed', () => {
    const w = ld('test-west.rgg'), e = ld('test-east.rgg');
    linkGraphs(w, e); unlinkGraph(e, [w]);
    expect(w.links.size).toBe(0);
  });
});

import { makeAvoid } from '../src/route/avoid';
describe('detours that keep away from other planned roads', () => {
  it('closes roads near a planned road and finds the way around', () => {
    // from the middle of West Rd to the middle of 2nd Street: either via Beach Road (south) or One Way Rd (north)
    const A: [number, number] = [80.0, 13.005], B: [number, number] = [80.01, 13.005];
    expect(route(g, A, B)!.distM).toBeLessThan(2300);
    // a planned road runs along the middle of Beach Road → that way is closed, go round by One Way Rd
    const viaNorth = routeMulti([g], A, B, { blocked: makeAvoid([80.003, 13.0, 80.007, 13.0], 25) })!;
    expect(viaNorth).not.toBeNull();
    expect(viaNorth.coords.every((c) => c[1] > 13.0 + 25 / 110540)).toBe(true);
    expect(viaNorth.coords.some((c) => near(c, [80.0, 13.01]))).toBe(true);
  });
  it('gives up rather than break the gap', () => {
    // planned roads on both Beach Road and One Way Rd → no safe way from West Rd to 2nd Street
    const avoid = makeAvoid([80.003, 13.0, 80.007, 13.0, 80.003, 13.01, 80.007, 13.01], 25);
    expect(routeMulti([g], [80.0, 13.005], [80.01, 13.005], { blocked: avoid })).toBeNull();
  });
});
