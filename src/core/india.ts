import type { LngLat } from './geo';

/**
 * Rough mainland India outline (≈60 points, a few km accuracy) — used for keeping
 * stress-test stops on Indian land. Proper state boundaries come with Phase 3.
 */
export const INDIA_OUTLINE: LngLat[] = [
  [68.2, 23.6], [68.9, 22.4], [70.1, 20.8], [72.6, 21.1], [72.8, 19.0], [73.3, 16.5], [74.3, 14.2], [74.9, 12.6],
  [75.9, 10.7], [76.3, 9.0], [77.0, 8.3], [77.55, 8.05], [78.2, 8.9], [79.3, 10.3], [79.9, 11.5], [80.35, 13.1], [80.3, 15.2],
  [81.3, 16.4], [82.3, 16.6], [84.9, 19.15], [85.95, 19.75], [87.0, 20.5], [87.9, 21.7], [88.9, 21.7], [89.0, 22.9], [88.6, 24.2],
  [88.0, 24.7], [88.4, 25.2], [88.9, 25.4], [89.8, 25.3], [92.4, 25.0], [92.0, 24.2], [91.4, 24.1], [91.2, 23.0],
  [91.8, 23.1], [92.3, 21.9], [93.4, 22.0], [94.2, 23.9], [94.6, 25.3], [95.2, 26.6], [97.0, 27.5], [97.4, 28.2],
  [96.1, 29.4], [94.6, 29.3], [92.0, 27.9], [91.6, 27.8], [92.0, 26.9], [88.9, 26.9], [88.8, 27.4], [88.9, 28.1],
  [88.0, 27.9], [88.1, 26.6], [86.0, 26.6], [84.1, 27.4], [83.3, 27.4], [81.1, 28.4], [80.1, 28.8], [80.9, 30.2],
  [79.0, 31.1], [78.8, 31.9], [78.6, 32.6], [79.5, 32.6], [80.2, 33.0], [79.5, 35.6], [77.8, 35.5], [76.5, 35.6],
  [75.0, 34.6], [74.0, 34.0], [73.9, 33.0], [74.6, 32.5], [75.4, 32.2], [74.6, 31.0], [73.9, 29.9], [72.9, 28.0],
  [70.6, 27.9], [69.6, 27.0], [70.3, 25.7], [71.1, 24.4], [68.8, 24.3],
];

export function pointInPolygon(p: LngLat, poly: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const inIndia = (p: LngLat) => pointInPolygon(p, INDIA_OUTLINE);

export function randomPointInIndia(): LngLat {
  for (;;) {
    const p: LngLat = [68 + Math.random() * 29.5, 8 + Math.random() * 27.7];
    if (inIndia(p)) return p;
  }
}

/** Random-walk stops that never leave Indian land. */
export function stressWalk(k: number, start?: LngLat): LngLat[] {
  let p: LngLat = start && inIndia(start) ? start : [79.08, 21.15]; // Nagpur, the centre of India
  let heading = Math.random() * Math.PI * 2;
  const out: LngLat[] = [];
  for (let i = 0; i < k; i++) {
    let next: LngLat | null = null;
    for (let tries = 0; tries < 16 && !next; tries++) {
      const h = heading + (Math.random() - 0.5) * (tries ? Math.PI * 2 : 0.9);
      const step = 0.01 + Math.random() * 0.02; // ≈1–3 km
      const c: LngLat = [p[0] + Math.cos(h) * step, p[1] + Math.sin(h) * step * 0.9];
      if (inIndia(c)) { next = c; heading = h; }
    }
    p = next ?? randomPointInIndia();
    out.push([+p[0].toFixed(6), +p[1].toFixed(6)]);
  }
  return out;
}
