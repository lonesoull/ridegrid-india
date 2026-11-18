import { db, getSetting, putSetting, type Trip } from './db';

/**
 * The app has two complete modes that never mix:
 *  - expedition: the fixed record route (waypoints, Guinness evidence, gap rules)
 *  - daily: everyday riding (real stops, traffic, expressways allowed, OsmAnd-style tools)
 * Each mode has its own trips, screens and last-opened trip. Map, offline road maps, GPS and
 * the team link are shared underneath.
 */
export type AppMode = 'expedition' | 'daily';
export const MODE_LABEL: Record<AppMode, string> = { expedition: 'Expedition', daily: 'Daily ride' };
export const DEFAULT_TRIP_NAME: Record<AppMode, string> = { expedition: 'My India Expedition', daily: 'My daily rides' };

export const tripMode = (t: Pick<Trip, 'kind'>): AppMode => (t.kind === 'daily' ? 'daily' : 'expedition');

export const mode = {
  current: 'expedition' as AppMode,
  /** false until the rider has picked a mode once (first launch shows the picker) */
  chosen: false,
  async load() {
    const m = await getSetting<AppMode | null>('appMode', null);
    this.chosen = m !== null;
    if (m) this.current = m;
    else {
      // existing installs: start in the mode of the trip that was open last
      const last = (await db.settings.get('activeTrip'))?.value as string | undefined;
      const t = last ? await db.trips.get(last) : undefined;
      if (t) this.current = tripMode(t);
    }
    return this.current;
  },
  async save(m: AppMode) { this.current = m; this.chosen = true; await putSetting('appMode', m); },
  /** last trip opened in this mode */
  lastTrip: (m: AppMode) => getSetting<string | null>(`activeTrip.${m}`, null),
  rememberTrip: (m: AppMode, id: string) => putSetting(`activeTrip.${m}`, id),
};
