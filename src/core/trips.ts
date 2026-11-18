import { db, uid, type SavedRoute, type Trip } from './db';
import { engine } from './engine';
import { app } from './app';
import { stressWalk } from './india';

export async function createTrip(name: string, targetKm?: number, kind: 'expedition' | 'daily' = 'expedition'): Promise<Trip> {
  const t: Trip = { id: uid(), name, targetKm, kind, createdAt: Date.now(), updatedAt: Date.now(), sequenceLock: kind === 'expedition', historyCursor: 0, historyTop: 0, coveredM: 0 };
  await db.trips.put(t);
  await db.drafts.put({ tripId: t.id, stops: [], updatedAt: Date.now(), cursor: 0 });
  return t;
}

export async function listTrips() { return db.trips.orderBy('updatedAt').reverse().toArray(); }

export async function deleteTrip(id: string) {
  await db.transaction('rw', [db.trips, db.drafts, db.routes, db.history], async () => {
    await db.trips.delete(id);
    await db.drafts.delete(id);
    await db.routes.where('tripId').equals(id).delete();
    await db.history.where('tripId').equals(id).delete();
  });
}

/** Ensure there is at least one trip and load the most recent one. */
export async function bootTrips() {
  let trips = await listTrips();
  if (!trips.length) { await createTrip('My India Expedition'); trips = await listTrips(); }
  const last = (await db.settings.get('activeTrip'))?.value as string | undefined;
  const t = trips.find((x) => x.id === last) ?? trips[0];
  await engine.loadTrip(t.id);
  app.applyTripRouting();
  return t;
}

export async function switchTrip(id: string) {
  await engine.loadTrip(id);
  app.applyTripRouting();
  await db.settings.put({ key: 'activeTrip', value: id });
  if (!engine.trip?.isStress) await db.settings.put({ key: 'lastRealTrip', value: id });
}

// ---------- stress test sandbox ----------
export const STRESS_NAME = '⚙ Stress Test (test stops only)';

/** Switch to (or create) the dedicated stress-test trip so real trips are never touched. */
export async function enterStressTrip() {
  if (engine.trip?.isStress) return;
  if (engine.trip) await db.settings.put({ key: 'lastRealTrip', value: engine.trip.id });
  let t = (await db.trips.toArray()).find((x) => x.isStress);
  if (!t) { t = await createTrip(STRESS_NAME); t.isStress = true; t.sequenceLock = false; await db.trips.put(t); }
  await switchTrip(t.id);
}

export async function addStressStops(k: number) {
  await enterStressTrip();
  const last = engine.stops[engine.stops.length - 1];
  const pts = stressWalk(k, last ? [last.lng, last.lat] : undefined);
  await engine.addMany(pts.map((p) => ({ p })));
}

/** Go back to the trip that was active before the stress test. */
export async function leaveStressTrip() {
  const all = await db.trips.toArray();
  const last = (await db.settings.get('lastRealTrip'))?.value as string | undefined;
  const real = all.find((t) => t.id === last && !t.isStress) ?? all.filter((t) => !t.isStress).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? (await createTrip('My India Expedition'));
  await switchTrip(real.id);
}

/** Clear all stress stops and delete the stress trip (with its undo history), then return to the real trip. */
export async function deleteStressTrip() {
  const t = (await db.trips.toArray()).find((x) => x.isStress);
  if (engine.trip?.isStress) await leaveStressTrip();
  if (t) await deleteTrip(t.id);
}

// ---------- saved routes library vs working draft ----------
export async function listRoutes(tripId: string) {
  return (await db.routes.where('tripId').equals(tripId).toArray()).sort((a, b) => b.createdAt - a.createdAt);
}

export async function saveDraftAsRoute(name: string): Promise<SavedRoute> {
  const t = engine.trip!;
  const r: SavedRoute = { id: uid(), tripId: t.id, name, stops: engine.snapshot(), distM: engine.routedM, createdAt: Date.now() };
  await db.routes.put(r);
  await engine.updateTrip({ draftSourceRouteId: r.id });
  return r;
}

export async function overwriteRoute(id: string) {
  const r = await db.routes.get(id);
  if (!r) return;
  await db.routes.put({ ...r, stops: engine.snapshot(), distM: engine.routedM, createdAt: Date.now() });
}

/** Continue editing a saved route: it becomes the working draft (undoable). */
export async function openRouteInDraft(id: string) {
  const r = await db.routes.get(id);
  if (!r) return;
  await engine.replaceAll(r.stops.map((s) => ({ id: s[0], lng: s[1], lat: s[2], name: s[3] })));
  await engine.updateTrip({ draftSourceRouteId: r.id });
}

/** Exit draft: discard unsaved draft edits and go back to the saved route it came from (or empty). */
export async function exitDraft() {
  const src = engine.trip?.draftSourceRouteId;
  const r = src ? await db.routes.get(src) : undefined;
  await engine.replaceAll(r ? r.stops.map((s) => ({ id: s[0], lng: s[1], lat: s[2], name: s[3] })) : []);
}

export async function duplicateRoute(id: string) {
  const r = await db.routes.get(id);
  if (!r) return;
  await db.routes.put({ ...r, id: uid(), name: `${r.name} (copy)`, createdAt: Date.now() });
}

export async function renameRoute(id: string, name: string) { await db.routes.update(id, { name }); }
export async function deleteRoute(id: string) { await db.routes.delete(id); }

// ---------- full database backup / restore ----------
export async function exportBackup(includeLegCache: boolean): Promise<Blob> {
  await engine.flush();
  const data: Record<string, unknown[]> = {
    trips: await db.trips.toArray(),
    drafts: await db.drafts.toArray(),
    routes: await db.routes.toArray(),
    history: await db.history.toArray(),
    settings: await db.settings.toArray(),
  };
  if (includeLegCache) data.legs = await db.legs.toArray();
  return new Blob([JSON.stringify({ app: 'ridegrid-india', format: 1, exportedAt: new Date().toISOString(), data })], { type: 'application/json' });
}

export async function importBackup(file: File, mode: 'merge' | 'replace') {
  const j = JSON.parse(await file.text());
  if (j?.app !== 'ridegrid-india' || !j.data) throw new Error('Not a RideGrid backup file');
  const d = j.data;
  const tables = [db.trips, db.drafts, db.routes, db.history, db.settings, db.legs];
  await db.transaction('rw', tables, async () => {
    // in merge mode, trips already on this device keep their own undo history
    const existing = new Set(mode === 'merge' ? await db.trips.toCollection().primaryKeys() : []);
    if (mode === 'replace') { for (const t of tables) if (t !== db.legs) await t.clear(); }
    if (d.trips) await db.trips.bulkPut(mode === 'merge' ? d.trips.filter((t: any) => !existing.has(t.id)) : d.trips);
    if (d.drafts) await db.drafts.bulkPut(mode === 'merge' ? d.drafts.filter((t: any) => !existing.has(t.tripId)) : d.drafts);
    if (d.routes) await db.routes.bulkPut(d.routes);
    if (d.history) {
      const rows = d.history.filter((h: any) => !existing.has(h.tripId)).map((h: any) => { const { id: _id, ...rest } = h; return rest; });
      await db.history.where('tripId').anyOf([...new Set(rows.map((r: any) => r.tripId))] as string[]).delete();
      await db.history.bulkAdd(rows);
    }
    if (d.settings) await db.settings.bulkPut(d.settings);
    if (d.legs) await db.legs.bulkPut(d.legs);
  });
  return bootTrips();
}
