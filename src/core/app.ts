import { engine } from './engine';
import { getSetting, putSetting } from './db';
import { RoutingQueue, osrmProvider, valhallaProvider, type Provider } from './router';

export interface RouterSettings { kind: 'osrm' | 'valhalla'; url: string }
export const DEFAULT_ROUTER: RouterSettings = { kind: 'osrm', url: 'https://router.project-osrm.org' };

export function makeProvider(s: RouterSettings): Provider {
  return s.kind === 'valhalla' ? valhallaProvider(s.url || undefined) : osrmProvider(s.url || undefined);
}

export const app = {
  queue: new RoutingQueue(osrmProvider(), engine),
  router: DEFAULT_ROUTER,
  async loadSettings() {
    this.router = await getSetting('router', DEFAULT_ROUTER);
    this.queue.setProvider(makeProvider(this.router));
  },
  /** Real trips auto-route; the stress-test trip never hits the routing servers. */
  applyTripRouting() { this.queue.setAuto(!engine.trip?.isStress); },
  async setRouter(s: RouterSettings) {
    this.router = s;
    await putSetting('router', s);
    this.queue.setProvider(makeProvider(s));
  },
};
