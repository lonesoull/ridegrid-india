import polyline from '@mapbox/polyline';

export type LngLat = [number, number];

const R = 6371008.8;
const rad = Math.PI / 180;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function lineLength(coords: LngLat[]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
  return d;
}

/** Decode Polyline6 (1e-6 precision) into [lng, lat] pairs. */
export function decode6(s: string): LngLat[] {
  return polyline.decode(s, 6).map(([lat, lng]) => [lng, lat] as LngLat);
}
export function encode6(coords: LngLat[]): string {
  return polyline.encode(coords.map(([lng, lat]) => [lat, lng]), 6);
}

/** Stable 1e-6 key for a coordinate (≈0.1 m). */
export const ckey = (p: LngLat) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

export function bounds(points: Iterable<LngLat>): [LngLat, LngLat] | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return minX === Infinity ? null : [[minX, minY], [maxX, maxY]];
}

/** Squared distance from point p to segment ab in a local equirectangular metre frame. */
export function distToSegmentM(p: LngLat, a: LngLat, b: LngLat): number {
  const k = Math.cos(p[1] * rad) * R * rad;
  const ax = (a[0] - p[0]) * k, ay = (a[1] - p[1]) * R * rad;
  const bx = (b[0] - p[0]) * k, by = (b[1] - p[1]) * R * rad;
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? -(ax * dx + ay * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.sqrt(x * x + y * y);
}

export function isValidLngLat(lng: number, lat: number) {
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

/** Sample a polyline every `stepM` metres (always keeps first and last). */
export function sampleLine(coords: LngLat[], stepM: number): LngLat[] {
  if (coords.length < 2) return coords.slice();
  const out: LngLat[] = [coords[0]];
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    acc += haversine(coords[i - 1], coords[i]);
    if (acc >= stepM) { out.push(coords[i]); acc = 0; }
  }
  const last = coords[coords.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export const fmtKm = (m: number) => (m >= 100000 ? (m / 1000).toFixed(0) : (m / 1000).toFixed(1)) + ' km';
