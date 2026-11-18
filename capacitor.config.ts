import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Android app is a thin native shell around the live web app, so every web update
 * reaches the app automatically on next launch. Native code (background GPS) is in /android.
 */
const config: CapacitorConfig = {
  appId: 'in.ridegrid.app',
  appName: 'RideGrid India',
  webDir: 'dist',
  server: {
    url: 'https://lonesoull.github.io/ridegrid-india/',
    androidScheme: 'https',
    errorPath: 'offline.html',
  },
  android: { allowMixedContent: false },
};

export default config;
