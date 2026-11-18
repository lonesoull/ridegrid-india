# RideGrid India

Offline-first, ₹0 route planner and ride navigator for an India motorcycle expedition (Guinness-style). 100k-stop scale, road-hugging Polyline6 geometry, runs in the browser, then packaged for Android, desktop and iOS (PWA).

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine + import/export tests
npm run build      # static site in dist/ (host free on GitHub Pages / Netlify / Cloudflare Pages)
```

## Phase 1 — Core planner (done)

| # | Feature | Where |
|---|---|---|
| 1, 4 | ₹0 stack, offline-first storage (IndexedDB via Dexie), service worker caches app + visited tiles | `src/core/db.ts`, `public/sw.js` |
| 5 | MapLibre WebGL map, pitch/tilt, day / night OLED, glove-size controls, slide-out drawer | `src/map`, `src/ui` |
| 6, 7, 18 | OSRM `overview`-quality road geometry from per-step Polyline6, chunked multi-waypoint requests (25 stops/request), paced ~1 req/s, exponential backoff on 429, every leg cached forever on device | `src/core/router.ts` |
| 8, 22 | 100k+ stops with zoom clusters showing count + stop range; +100 / +1,000 / +10,000 stress generator, FPS meter | `MapController.ts`, Tools tab |
| 9–11 | Tap to add (snapped to nearest road), insert-on-line mode, drag stop (only the 2 adjacent legs recalculated), delete bridges N-1 → N+1 | `engine.ts` |
| 12 | Unlimited undo/redo — command diffs stored in IndexedDB, survives restarts | `engine.ts` |
| 13, 14 | Bulk import GPX/KML/KMZ/GeoJSON/CSV/XLSX/FIT/TCX; export GPX 1.1, styled KML, CSV logbook | `src/io` |
| 15–17 | Trips (Mapped / Covered / Left, target km), working draft vs saved routes library, full JSON backup/restore | `trips.ts`, Trip/Files tabs |
| 19–21, 23 | Sequence Lock, reverse / clear / fit / snap view, add by lat-lng, paste coordinate lists, paginated inspector + jump to #N | Stops tab |

Routing engine is switchable (Tools tab): OSRM or Valhalla (motorcycle), public or your own server URL.

## Next phases

2. Navigation: GPS journey player & simulator, off-route / arrival alerts, wake lock, Google Maps backup dispatcher
3. On-device offline router (per-state road graphs) + Guinness/India compliance modules
4. Supabase live telemetry for ≤10 devices, route push, offline POIs, SOS
5. Packaging: Android APK (Capacitor), desktop (Tauri), iOS PWA
