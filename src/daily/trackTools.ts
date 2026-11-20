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

export type ColourBy = 'speed' | 'altitude' | 'slope' | 'solid';
const ramp = (t: number) => { // 0..1 → red → yellow → green → blue
  const stops = [[211, 47, 47], [245, 124, 0], [251, 192, 45], [124, 179, 66], [30, 136, 229], [106, 27, 154]];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};
/** Coloured segments for the map: by speed, altitude, slope (OsmAnd track appearance) or one colour. */
export function colouredTrack(pts: RidePoint[], by: ColourBy = 'speed', solid = '#e53935'): GeoJSON.FeatureCollection {
  const feats: GeoJSON.Feature[] = [];
  const alts = pts.map((p) => (p as any)[5]).filter(Number.isFinite) as number[];
  const amin = alts.length ? Math.min(...alts) : 0, aspan = alts.length ? Math.max(10, Math.max(...alts) - amin) : 1;
  const step = Math.max(1, Math.floor(pts.length / 4000));
  for (let i = step; i < pts.length; i += step) {
    const a = pts[i - step], b = pts[i], dt = (b[0] - a[0]) / 1000, d = haversine([a[1], a[2]], [b[1], b[2]]);
    let c = solid;
    if (by === 'speed') { const v = (b[4] > 0 ? b[4] : dt > 0 ? d / dt : 0) * 3.6; c = ramp(Math.min(120, v) / 100); }
    else if (by === 'altitude') { const z = (b as any)[5]; c = Number.isFinite(z) ? ramp(1 - (z - amin) / aspan) : '#999'; }
    else if (by === 'slope') { const za = (a as any)[5], zb = (b as any)[5]; const g = Number.isFinite(za) && Number.isFinite(zb) && d > 5 ? ((zb - za) / d) * 100 : 0; c = ramp(0.5 - g / 20); }
    feats.push({ type: 'Feature', properties: { c }, geometry: { type: 'LineString', coordinates: [[a[1], a[2]], [b[1], b[2]]] } });
  }
  return { type: 'FeatureCollection', features: feats };
}

let shown: GeoJSON.FeatureCollection | null = null;
export function installTrackLayer(ctl: MapController) {
  ctl.styleHooks.add((m) => {
    if (m.getSource('d-track')) return;
    m.addSource('d-track', { type: 'geojson', data: shown ?? { type: 'FeatureCollection', features: [] } });
    m.addLayer({ id: 'd-track-line', type: 'line', source: 'd-track', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-width': 5, 'line-color': ['coalesce', ['get', 'c'], '#e53935'] } });
  });
}
export function showTrack(ctl: MapController, fc: GeoJSON.FeatureCollection | null) {
  shown = fc;
  (ctl.map.getSource('d-track') as GeoJSONSource | undefined)?.setData(fc ?? { type: 'FeatureCollection', features: [] });
}

/** Import a GPX or KML file into the Daily track library (keeps times and altitude). */
export async function importGpxTrack(f: File, tripId: string, folder: string): Promise<Ride> {
  const text = await f.text();
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const t0 = Date.now();
  let pts: RidePoint[];
  if (/\.kml$/i.test(f.name) || xml.documentElement.nodeName === 'kml') {
    // KML: gx:Track (when + gx:coord) or LineString coordinates
    const whens = [...xml.getElementsByTagName('when')].map((n) => Date.parse(n.textContent ?? ''));
    const gx = [...xml.getElementsByTagName('gx:coord')].map((n) => (n.textContent ?? '').trim().split(/\s+/).map(Number));
    const ls = gx.length ? gx : [...xml.getElementsByTagName('LineString')].flatMap((l) => (l.getElementsByTagName('coordinates')[0]?.textContent ?? '').trim().split(/\s+/).map((c) => c.split(',').map(Number)));
    pts = ls.filter((c) => c.length >= 2 && Number.isFinite(c[0])).map((c, i) => [whens[i] || t0 + i * 1000, c[0], c[1], 5, 0, Number.isFinite(c[2]) ? c[2] : NaN] as RidePoint);
  } else {
    pts = [...xml.querySelectorAll('trkpt, rtept')].map((n, i) => {
      const t = Date.parse(n.querySelector('time')?.textContent ?? '') || t0 + i * 1000;
      const ele = parseFloat(n.querySelector('ele')?.textContent ?? '');
      return [t, +n.getAttribute('lon')!, +n.getAttribute('lat')!, 5, 0, Number.isFinite(ele) ? ele : NaN] as RidePoint;
    });
  }
  if (pts.length < 2) throw new Error('No track in this file');
  const st = analyse(pts);
  const r: Ride = { id: uid(), tripId, startedAt: pts[0][0], endedAt: pts[pts.length - 1][0], distM: st.distM, points: pts.length, simulated: false,
    name: xml.querySelector('trk > name, metadata > name, Placemark > name, Document > name')?.textContent?.trim() || f.name.replace(/\.(gpx|kml)$/i, ''), folder, source: 'import' };
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

/** Save points as a new library track. */
export async function saveTrack(pts: RidePoint[], name: string, tripId: string, folder: string, source: Ride['source'] = 'import') {
  const st = analyse(pts, 999);
  const r: Ride = { id: uid(), tripId, startedAt: pts[0][0], endedAt: pts[pts.length - 1][0], distM: st.distM, points: pts.length, simulated: false, name, folder, source };
  await db.rides.put(r);
  for (let i = 0; i < pts.length; i += 500) await db.rideChunks.add({ rideId: r.id, pts: pts.slice(i, i + 500) });
  return r;
}

/** Join tracks into one (in time order). */
export async function joinTracks(rides: Ride[], tripId: string) {
  const all = (await Promise.all(rides.map((r) => trackPoints(r.id)))).flat().sort((a, b) => a[0] - b[0]);
  return saveTrack(all, `${rides[0].name} + ${rides.length - 1} more`, tripId, rides[0].folder ?? 'Rides');
}

/** Split a track at a distance (km) into two new tracks. */
export async function splitTrack(r: Ride, atKm: number) {
  const pts = await trackPoints(r.id);
  let d = 0, k = pts.length;
  for (let i = 1; i < pts.length; i++) { d += haversine([pts[i - 1][1], pts[i - 1][2]], [pts[i][1], pts[i][2]]); if (d >= atKm * 1000) { k = i; break; } }
  if (k <= 1 || k >= pts.length - 1) throw new Error('Split point is outside the track');
  await saveTrack(pts.slice(0, k + 1), `${r.name} (1)`, r.tripId, r.folder ?? 'Rides', r.source);
  await saveTrack(pts.slice(k), `${r.name} (2)`, r.tripId, r.folder ?? 'Rides', r.source);
}

/** Snap a GPS track to the roads (OsmAnd "GPX approximation"): OSRM map-matching online, else the on-device router. */
export async function snapTrack(r: Ride, routeOffline: (pts: LngLat[]) => Promise<(LngLat[] | null)[]>) {
  const pts = await trackPoints(r.id);
  // sample every ~100 m
  const smp: LngLat[] = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i) acc += haversine([pts[i - 1][1], pts[i - 1][2]], [pts[i][1], pts[i][2]]);
    if (!i || acc >= 100 || i === pts.length - 1) { smp.push([pts[i][1], pts[i][2]]); acc = 0; }
  }
  let line: LngLat[] = [];
  // Google Roads "snap to roads" first, then OSRM map-matching, then the on-device router
  try { const { googleReady, googleSnap } = await import('./gfeatures'); if (googleReady()) line = await googleSnap(smp); } catch { line = []; }
  if (!line.length && navigator.onLine) {
    for (let i = 0; i < smp.length - 1; i += 99) {
      const chunk = smp.slice(i, i + 100);
      const j = await fetch(`https://router.project-osrm.org/match/v1/driving/${chunk.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';')}?overview=full&geometries=geojson&radiuses=${chunk.map(() => 30).join(';')}&gaps=ignore`).then((x) => x.json()).catch(() => null);
      const g = j?.matchings?.flatMap((m: any) => m.geometry.coordinates) as LngLat[] | undefined;
      if (!g?.length) { line = []; break; }
      line.push(...g);
      await new Promise((res) => setTimeout(res, 1100)); // public server: ~1 request / second
    }
  }
  if (!line.length) {
    const legs = await routeOffline(smp);
    if (legs.some((l) => !l)) throw new Error('Could not match this track to roads (download the region for offline matching)');
    line = legs.flatMap((l) => l!);
  }
  const t0 = pts[0][0], dt = (pts[pts.length - 1][0] - t0) / Math.max(1, line.length - 1);
  return saveTrack(line.map((p, i) => [t0 + i * dt, p[0], p[1], 5, 0] as RidePoint), `${r.name} (on roads)`, r.tripId, r.folder ?? 'Rides', r.source);
}
