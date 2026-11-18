import Dexie, { type Table } from 'dexie';

/** Compact stop tuple: [id, lng, lat, name?] — keeps 100k stops small on disk & in RAM. */
export type StopTuple = [string, number, number, string?];

export interface Trip {
  id: string;
  name: string;
  targetKm?: number;
  createdAt: number;
  updatedAt: number;
  sequenceLock: boolean;
  historyCursor: number; // seq of last applied command (0 = none)
  historyTop: number;    // highest seq stored
  draftSourceRouteId?: string;
  coveredM: number;      // filled by ride logging in Phase 2
  isStress?: boolean;    // throw-away trip for scale testing (never auto-routed)
}
export interface Draft { tripId: string; stops: StopTuple[]; updatedAt: number; cursor?: number /* history seq this snapshot reflects */ }
export interface SavedRoute { id: string; tripId: string; name: string; stops: StopTuple[]; distM: number; createdAt: number }
export interface HistoryEntry { id?: number; tripId: string; seq: number; cmd: unknown }
export interface LegCacheEntry { key: string; poly: string; distM: number; provider: string; at: number }
export interface Setting { key: string; value: unknown }

export class RideDB extends Dexie {
  trips!: Table<Trip, string>;
  drafts!: Table<Draft, string>;
  routes!: Table<SavedRoute, string>;
  history!: Table<HistoryEntry, number>;
  legs!: Table<LegCacheEntry, string>;
  settings!: Table<Setting, string>;
  constructor(name = 'ridegrid') {
    super(name);
    this.version(1).stores({
      trips: 'id, updatedAt',
      drafts: 'tripId',
      routes: 'id, tripId, createdAt',
      history: '++id, [tripId+seq], tripId',
      legs: 'key',
      settings: 'key',
    });
  }
}

export let db = new RideDB();
/** For tests. */
export function useDB(d: RideDB) { db = d; }

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const s = await db.settings.get(key);
  return s ? (s.value as T) : fallback;
}
export const putSetting = (key: string, value: unknown) => db.settings.put({ key, value });
