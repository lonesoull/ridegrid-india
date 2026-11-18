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
  /** expedition = fixed record route with waypoints; daily = normal rides with real stops (default: expedition) */
  kind?: 'expedition' | 'daily';
}
export interface Draft { tripId: string; stops: StopTuple[]; updatedAt: number; cursor?: number /* history seq this snapshot reflects */ }
export interface SavedRoute { id: string; tripId: string; name: string; stops: StopTuple[]; distM: number; createdAt: number }
export interface HistoryEntry { id?: number; tripId: string; seq: number; cmd: unknown }
export interface LegCacheEntry { key: string; poly: string; distM: number; provider: string; at: number; turns?: import('./turns').Turn[] }
export interface Setting { key: string; value: unknown }
export interface Ride { id: string; tripId: string; startedAt: number; endedAt?: number; distM: number; points: number; simulated: boolean; name: string }
/** Ride GPS points in chunks: [timeMs, lng, lat, accuracyM, speedMps] */
export type RidePoint = [number, number, number, number, number];
export interface RideChunk { id?: number; rideId: string; pts: RidePoint[] }
export type StopType = 'daystart' | 'dayend' | 'overnight' | 'police' | 'witness' | 'fuel' | 'service' | 'food' | 'evidence' | 'media' | 'other' | 'break';
/** Who signed / gave a witness statement (they write the statement themselves; the app only records who and where). */
export interface Witness { name: string; role?: string; org?: string; phone?: string; gazetted?: boolean; independent?: boolean }
/** Logbook entry: a real stop (overnight, police signature…) or an automatically detected break. */
export interface StopLog {
  id: string; tripId: string; rideId?: string;
  type: StopType; auto?: boolean;
  at: number; endAt?: number;
  lng: number; lat: number; acc?: number;
  odoKm?: number; note?: string;
  /** photos and videos (an evidence photo keeps the original and a copy with GPS/time printed on it) */
  photos?: Blob[];
  witness?: Witness;
  /** media article / video link */
  link?: string;
  /** human place name (reverse geocoded), e.g. "Taramani, Chennai, Tamil Nadu" */
  place?: string;
}

export class RideDB extends Dexie {
  trips!: Table<Trip, string>;
  drafts!: Table<Draft, string>;
  routes!: Table<SavedRoute, string>;
  history!: Table<HistoryEntry, number>;
  legs!: Table<LegCacheEntry, string>;
  settings!: Table<Setting, string>;
  rides!: Table<Ride, string>;
  rideChunks!: Table<RideChunk, number>;
  stopLogs!: Table<StopLog, string>;
  graphs!: Table<{ zone: string; blob: Blob; bytes: number; at: number; generated?: string }, string>;
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
    this.version(2).stores({
      rides: 'id, tripId, startedAt',
      rideChunks: '++id, rideId',
    });
    this.version(3).stores({ stopLogs: 'id, tripId, at' });
    this.version(4).stores({ graphs: 'zone' });
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
