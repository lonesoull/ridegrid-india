import { db, type Ride } from '../core/db';
import { engine } from '../core/engine';

export async function listRides(tripId: string): Promise<Ride[]> {
  return (await db.rides.where('tripId').equals(tripId).toArray()).sort((a, b) => b.startedAt - a.startedAt);
}

/** Delete a ride log and remove its distance from the trip's "covered" total. */
export async function deleteRide(id: string) {
  await db.transaction('rw', db.rides, db.rideChunks, db.trips, async () => {
    const r = await db.rides.get(id);
    if (!r) return;
    const t = await db.trips.get(r.tripId);
    if (t) { t.coveredM = Math.max(0, (t.coveredM ?? 0) - r.distM); await db.trips.put(t); if (engine.trip?.id === t.id) engine.trip.coveredM = t.coveredM; }
    await db.rideChunks.where('rideId').equals(id).delete();
    await db.rides.delete(id);
  });
}

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));

/** Timestamped GPX 1.1 track of a ride — every point carries its UTC time (evidence-grade log). */
export async function rideGPX(r: Ride): Promise<string> {
  const chunks = await db.rideChunks.where('rideId').equals(r.id).sortBy('id');
  const p: string[] = [];
  p.push(`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RideGrid India" xmlns="http://www.topografix.com/GPX/1/1">`);
  p.push(`<metadata><name>${esc(r.name)}</name><desc>${r.simulated ? 'SIMULATED ride (not real GPS). ' : ''}${(r.distM / 1000).toFixed(2)} km, ${r.points} points</desc><time>${new Date(r.startedAt).toISOString()}</time></metadata>`);
  p.push(`<trk><name>${esc(r.name)}</name><type>${r.simulated ? 'simulation' : 'motorcycle'}</type><trkseg>`);
  for (const c of chunks) for (const [t, lng, lat, acc, spd] of c.pts) {
    p.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"><time>${new Date(t).toISOString()}</time><desc>acc=${acc}m speed=${(spd * 3.6).toFixed(1)}km/h</desc></trkpt>`);
  }
  p.push('</trkseg></trk></gpx>');
  return p.join('\n');
}
