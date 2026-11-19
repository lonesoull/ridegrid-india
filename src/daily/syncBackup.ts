import { db, getSetting, putSetting, type MyPlace } from '../core/db';
import { dailyMap } from './mapLayers';
import { dailyNav } from './dailyNav';
import { widgets } from './widgets';
import { quick } from './QuickActions';
import { recorder } from './recorder';
import { bikes } from './profiles';
import { markers } from './markers';

/** Daily settings + places as one bundle: file backup/restore and sharing with your other devices. */
export interface DailyBundle { app: 'ridegrid-daily'; v: 1; at: number; settings: Record<string, unknown>; places: Omit<MyPlace, 'media'>[] }

export async function makeBundle(withPlaces = true): Promise<DailyBundle> {
  return {
    app: 'ridegrid-daily', v: 1, at: Date.now(),
    settings: { dailyMap: dailyMap.settings, dailyNav: dailyNav.s, dailyWidgets: widgets.s, quickActions: quick.list, recorder: recorder.s, bikes: bikes.list, activeBike: bikes.activeId,
      access: await getSetting('access', null) },
    places: withPlaces ? (await db.myplaces.toArray()).map(({ media: _m, ...x }) => x) : [],
  };
}

/** Apply a bundle (settings replaced, places merged by id — newer wins). */
export async function applyBundle(b: DailyBundle, opts = { settings: true, places: true }) {
  if (b?.app !== 'ridegrid-daily') throw new Error('Not a RideGrid Daily settings file');
  if (opts.settings) {
    for (const [k, v] of Object.entries(b.settings)) if (v !== null && v !== undefined) await putSetting(k, v);
    await Promise.all([dailyMap.load(), dailyNav.load(), widgets.load(), quick.load(), recorder.load(), bikes.load()]);
  }
  if (opts.places) {
    for (const p of b.places) {
      const have = await db.myplaces.get(p.id);
      if (!have || have.at <= p.at) await db.myplaces.put({ ...have, ...p });
    }
    await markers.load();
  }
}
