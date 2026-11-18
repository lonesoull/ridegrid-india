import { Capacitor, registerPlugin } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';

/**
 * One GPS stream for both worlds:
 *  - Android app: native foreground service — keeps recording with the screen off / app in background.
 *  - Browser: navigator.geolocation (stops when the screen is off).
 */
const BG = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

export interface GpsFix {
  lng: number; lat: number; acc: number;
  speed: number | null; heading: number | null; time: number;
  /** true when Android says the position came from a mock-location (fake GPS) app */
  mock: boolean;
}

export const isNativeApp = () => Capacitor.isNativePlatform();

export async function watchGps(onFix: (f: GpsFix) => void, onError: (msg: string, code?: string) => void): Promise<() => void> {
  if (isNativeApp()) {
    const id = await BG.addWatcher(
      {
        backgroundTitle: 'RideGrid is recording your ride',
        backgroundMessage: 'GPS keeps logging with the screen off. Tap to open.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      },
      (loc, err) => {
        if (err) {
          onError(err.code === 'NOT_AUTHORIZED' ? 'Location permission is off for RideGrid. Allow “Precise location” in app settings.' : `GPS: ${err.message}`, err.code);
          return;
        }
        if (!loc) return;
        onFix({ lng: loc.longitude, lat: loc.latitude, acc: loc.accuracy, speed: loc.speed, heading: loc.bearing, time: loc.time ?? Date.now(), mock: !!loc.simulated });
      },
    );
    return () => { void BG.removeWatcher({ id }); };
  }
  if (!navigator.geolocation) { onError('GPS is not available on this device.'); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    (p) => onFix({ lng: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy, speed: p.coords.speed, heading: p.coords.heading, time: p.timestamp, mock: false }),
    (e) => onError(e.code === 1 ? 'Location permission denied — allow location for this site.' : `GPS: ${e.message}`, String(e.code)),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

export const openAppSettings = () => (isNativeApp() ? BG.openSettings() : Promise.resolve());
