import { engine } from './engine';
import { getSetting, putSetting } from './db';
import { RoutingQueue, osrmProvider, valhallaProvider, OSRM_PUBLIC, OSRM_FOSSGIS, type Provider } from './router';

export interface RouterSettings { kind: 'osrm' | 'valhalla'; url: string; parallel?: boolean }
export const DEFAULT_ROUTER: RouterSettings = { kind: 'osrm', url: OSRM_PUBLIC, parallel: true };

export function makeProvider(s: RouterSettings): Provider {
  return s.kind === 'valhalla' ? valhallaProvider(s.url || undefined) : osrmProvider(s.url || undefined);
}

/** Primary server plus, for the free public OSRM, a second free OSRM server working in parallel. */
export function makeProviders(s: RouterSettings): Provider[] {
  const primary = makeProvider(s);
  const isPublicOsrm = s.kind === 'osrm' && (!s.url || s.url.includes('project-osrm.org'));
  return isPublicOsrm && s.parallel !== false ? [primary, osrmProvider(OSRM_FOSSGIS)] : [primary];
}

export const app = {
  queue: new RoutingQueue(osrmProvider(), engine),
  router: DEFAULT_ROUTER,
  async loadSettings() {
    this.router = { ...DEFAULT_ROUTER, ...(await getSetting('router', DEFAULT_ROUTER)) };
    this.queue.setProviders(makeProviders(this.router));
  },
  /** Real trips auto-route; the stress-test trip never hits the routing servers. */
  applyTripRouting() { this.queue.setAuto(!engine.trip?.isStress); },
  async setRouter(s: RouterSettings) {
    this.router = s;
    await putSetting('router', s);
    this.queue.setProviders(makeProviders(s));
  },
};
