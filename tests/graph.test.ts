import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Graph, route } from '../src/route/graph';

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
