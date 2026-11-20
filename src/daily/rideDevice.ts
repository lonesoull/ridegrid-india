import { Capacitor, registerPlugin } from '@capacitor/core';

/** Native phone features (Android app): turn notification, wake screen, light sensor, GPS satellites. */
interface RideDevice {
  notify(o: { title: string; text: string }): Promise<void>;
  clear(): Promise<void>;
  wake(o: { ms: number }): Promise<void>;
  status(): Promise<{ lux: number; satsUsed: number; satsSeen: number; cn0: number }>;
}
const plugin = registerPlugin<RideDevice>('RideDevice');
const native = () => Capacitor.isNativePlatform();
export const rideDevice = {
  notify: (title: string, text: string) => (native() ? plugin.notify({ title, text }).catch(() => {}) : Promise.resolve()),
  clear: () => (native() ? plugin.clear().catch(() => {}) : Promise.resolve()),
  wake: (ms = 12000) => (native() ? plugin.wake({ ms }).catch(() => {}) : Promise.resolve()),
  status: async () => (native() ? plugin.status().catch(() => null) : null),
};
