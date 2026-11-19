import { db, uid, type Ride, type RidePoint } from '../core/db';
import { haversine, type LngLat } from '../core/geo';
import type { GeoJSONSource } from 'maplibre-gl';
import type { MapController } from '../map/MapController';

/** Track statistics, splits and graphs (OsmAnd "Track analysis"). */
export interface TrackStats {
  distM: number; durS: number; movingS: number; avgKmh: number; maxKmh: number; climbM: number; descentM: number; minAlt: number; maxAlt: number;
  speed: { s: number; v: number }[]; alt: { s: number; v: number }[]; splits: { km: number; s: number }[]; pts: RidePoint[];
}

export async function trackPoints(rideId: string): Promise<RidePoint[]> {
  const chunks = await db.rideChunks.where('rideId').equals(rideId).sortBy('id');
  return chunks.flatMap((c) => c.pts);
}

export function analyse(pts: RidePoint[], maxAcc = 50): TrackStats {
  const good = pts.filter((p) => p[3] <= maxAcc);
  let distM = 0, movingS = 0, maxMps = 0, up = 0, down = 0, lastAlt: number | null = null, nextSplit = 1000, splitT = good[0]?.[0] ?? 0;
  const speed: { s: number; v: number }[] = [], alt: { s: number; v: number }[] = [], splits: { km: number; s: number }[] = [];
  let minAlt = Infinity, maxAlt = -Infinity;
  for (let i = 1; i < good.length; i++) {
    const a = good[i - 1], b = good[i];
    const d = haversine([a[1], a[2]], [b[1], b[2]]), dt = (b[0] - a[0]) / 1000;
    if (dt <= 0 || d / dt > 70) continue;
    distM += d;
    const v = b[4] > 0 ? b[4] : d / dt;
    if (v > 1.5 && dt < 120) movingS += dt;
    maxMps = Math.max(maxMps, Math.min(v, 70));
    if (i % Math.max(1, Math.floor(good.length / 300)) === 0) speed.push({ s: distM, v: v * 3.6 });
    const z = (b as any)[5];
    if (Number.isFinite(z)) {
      minAlt = Math.min(minAlt, z); maxAlt = Math.max(maxAlt, z);
      if (lastAlt === null) lastAlt = z; else if (Math.abs(z - lastAlt) > 3) { if (z > lastAlt) up += z - lastAlt; else down += lastAlt - z; lastAlt = z; }
      if (i % Math.max(1, Math.floor(good.length / 300)) === 0) alt.push({ s: distM, v: z });
    }
    while (distM >= nextSplit) { splits.push({ km: nextSplit / 1000, s: (b[0] - splitT) / 1000 }); splitT = b[0]; nextSplit += 1000; }
  }
  const durS = good.length > 1 ? (good[good.length - 1][0] - good[0][0]) / 1000 : 0;
  return { distM, durS, movingS, avgKmh: movingS ? (distM / movingS) * 3.6 : 0, maxKmh: maxMps * 3.6, climbM: up, descentM: down,
    minAlt: Number.isFinite(minAlt) ? minAlt : NaN, maxAlt: Number.isFinite(maxAlt) ? maxAlt : NaN, speed, alt, splits, pts: good };
}

/** Coloured segments (by speed) for the map. */
export function colouredTrack(pts: RidePoint[]): GeoJSON.FeatureCollection {
  const feats: GeoJSON.Feature[] = [];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1], b = pts[i], dt = (b[0] - a[0]) / 1000;
    const v = (b[4] > 0 ? b[4] : dt > 0 ? haversine([a[1], a[2]], [b[1], b[2]]) / dt : 0) * 3.6;
    feats.push({ type: 'Feature', properties: { v: Math.min(120, v) }, geometry: { type: 'LineString', coordinates: [[a[1], a[2]], [b[1], b[2]]] } });
  }
  return { type: 'FeatureCollection', features: feats };
}

let shown: GeoJSON.FeatureCollection | null = null;
export function installTrackLayer(ctl: MapController) {
  ctl.styleHooks.add((m) => {
    if (m.getSource('d-track')) return;
    m.addSource('d-track', { type: 'geojson', data: shown ?? { type: 'FeatureCollection', features: [] } });
    m.addLayer({ id: 'd-track-line', type: 'line', source: 'd-track', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': 5, 'line-color': ['interpolate', ['linear'], ['get', 'v'], 0, '#d32f2f', 20, '#f57c00', 40, '#fbc02d', 60, '#7cb342', 80, '#1e88e5', 100, '#6a1b9a'] } });
  });
}
export function showTrack(ctl: MapController, fc: GeoJSON.FeatureCollection | null) {
  shown = fc;
  (ctl.map.getSource('d-track') as GeoJSONSource | undefined)?.setData(fc ?? { type: 'FeatureCollection', features: [] });
}

/** Import a GPX file into the Daily track library (keeps times and altitude). */
export async function importGpxTrack(f: File, tripId: string, folder: string): Promise<Ride> {
  const xml = new DOMParser().parseFromString(await f.text(), 'application/xml');
  const nodes = [...xml.querySelectorAll('trkpt, rtept')];
  if (nodes.length < 2) throw new Error('No track in this GPX file');
  const t0 = Date.now();
  const pts: RidePoint[] = nodes.map((n, i) => {
    const t = Date.parse(n.querySelector('time')?.textContent ?? '') || t0 + i * 1000;
    const ele = parseFloat(n.querySelector('ele')?.textContent ?? '');
    return [t, +n.getAttribute('lon')!, +n.getAttribute('lat')!, 5, 0, Number.isFinite(ele) ? ele : NaN] as RidePoint;
  });
  const st = analyse(pts);
  const r: Ride = { id: uid(), tripId, startedAt: pts[0][0], endedAt: pts[pts.length - 1][0], distM: st.distM, points: pts.length, simulated: false,
    name: xml.querySelector('trk > name, metadata > name')?.textContent?.trim() || f.name.replace(/\.gpx$/i, ''), folder, source: 'import' };
  await db.rides.put(r);
  for (let i = 0; i < pts.length; i += 500) await db.rideChunks.add({ rideId: r.id, pts: pts.slice(i, i + 500) });
  return r;
}

/** Save a planned / measured line as a track. */
export async function saveLineAsTrack(coords: LngLat[], name: string, tripId: string, folder: string) {
  const t0 = Date.now();
  const pts: RidePoint[] = coords.map((c, i) => [t0 + i * 1000, c[0], c[1], 5, 0] as RidePoint);
  const distM = coords.slice(1).reduce((m, p, i) => m + haversine(coords[i], p), 0);
  const r: Ride = { id: uid(), tripId, startedAt: t0, endedAt: t0 + coords.length * 1000, distM, points: pts.length, simulated: false, name, folder, source: 'plan' };
  await db.rides.put(r);
  await db.rideChunks.add({ rideId: r.id, pts });
  return r;
}

export function gpxOf(r: Ride, pts: RidePoint[]): string {
  const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
  return [`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RideGrid India" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<trk><name>${esc(r.name)}</name><trkseg>`,
    ...pts.map((p) => `<trkpt lat="${p[2].toFixed(7)}" lon="${p[1].toFixed(7)}">${Number.isFinite((p as any)[5]) ? `<ele>${(p as any)[5].toFixed(1)}</ele>` : ''}<time>${new Date(p[0]).toISOString()}</time></trkpt>`),
    '</trkseg></trk></gpx>'].join('\n');
}
