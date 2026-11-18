import { db } from '../core/db';
import { haversine, type LngLat } from '../core/geo';

/** Every road already ridden on this trip (real GPS rides), decimated to ~50 m for drawing (#28). */
export async function riddenLines(tripId: string): Promise<LngLat[][]> {
  const out: LngLat[][] = [];
  for (const r of await db.rides.where('tripId').equals(tripId).filter((x) => !x.simulated).toArray()) {
    let line: LngLat[] = [];
    let last: LngLat | null = null;
    for (const c of await db.rideChunks.where('rideId').equals(r.id).sortBy('id')) for (const pt of c.pts) {
      if (pt[3] > 50) continue;
      const p: LngLat = [pt[1], pt[2]];
      if (last && haversine(last, p) > 2000) { out.push(line); line = []; } // GPS gap: start a new piece
      if (!last || haversine(last, p) >= 50 || line.length === 0) { line.push(p); last = p; }
    }
    if (line.length > 1) out.push(line);
  }
  return out;
}
