import type { Graph } from './graph';

const RAD = Math.PI / 180, R = 6371008.8, CELL = 0.002;

/**
 * "Keep away from these lines": closes every road edge that comes within `gapM` of any given
 * segment (crossing it, joining it, running parallel to it, passing over or under it).
 * segs = flat [x0, y0, x1, y1, …] in degrees. Checked lazily per edge during the search.
 */
export function makeAvoid(segs: number[], gapM: number) {
  const near = nearLines(segs, gapM);
  const cache = new Map<Graph, Map<number, boolean>>();
  return (g: Graph, e: number): boolean => {
    let c = cache.get(g); if (!c) cache.set(g, (c = new Map()));
    const hit = c.get(e); if (hit !== undefined) return hit;
    const pts = g.edgeCoords(e);
    let bad = false;
    for (let i = 0; i < pts.length - 1 && !bad; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const m = Math.hypot((x1 - x0) * Math.cos(y0 * RAD) * R * RAD, (y1 - y0) * R * RAD);
      const steps = Math.max(1, Math.ceil(m / Math.max(5, gapM / 2)));
      for (let k = 0; k <= steps; k++) if (near(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps)) { bad = true; break; }
    }
    c.set(e, bad);
    return bad;
  };
}

/** Junctions within `radiusM` of the given lines (e.g. "back on my road, near where I left it"). */
export function makeNearGoal(segs: number[], radiusM: number) {
  const near = nearLines(segs, radiusM);
  return (g: Graph, v: number) => near(g.lon[v] / 1e6, g.lat[v] / 1e6);
}

/** Fast "is (x, y) within gapM of any of these segments?" test using a small grid. */
export function nearLines(segs: number[], gapM: number) {
  const n = segs.length / 4;
  const cells = new Map<number, number[]>();
  const pad = gapM / (R * RAD) * 2;
  for (let i = 0; i < n; i++) {
    const x0 = Math.min(segs[4 * i], segs[4 * i + 2]) - pad, x1 = Math.max(segs[4 * i], segs[4 * i + 2]) + pad;
    const y0 = Math.min(segs[4 * i + 1], segs[4 * i + 3]) - pad, y1 = Math.max(segs[4 * i + 1], segs[4 * i + 3]) + pad;
    const cx0 = Math.floor(x0 / CELL), cx1 = Math.floor(x1 / CELL), cy0 = Math.floor(y0 / CELL), cy1 = Math.floor(y1 / CELL);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 2500) continue;
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const k = (cx + 200000) * 400000 + (cy + 200000);
      const a = cells.get(k); if (a) a.push(i); else cells.set(k, [i]);
    }
  }
  const near = (x: number, y: number) => {
    const a = cells.get((Math.floor(x / CELL) + 200000) * 400000 + (Math.floor(y / CELL) + 200000));
    if (!a) return false;
    const kx = Math.cos(y * RAD) * R * RAD, ky = R * RAD;
    for (const i of a) {
      const ax = (segs[4 * i] - x) * kx, ay = (segs[4 * i + 1] - y) * ky, bx = (segs[4 * i + 2] - x) * kx, by = (segs[4 * i + 3] - y) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      if (Math.hypot(ax + t * dx, ay + t * dy) < gapM) return true;
    }
    return false;
  };
  return near;
}
