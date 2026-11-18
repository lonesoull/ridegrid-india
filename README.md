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

## Phase 2 — Navigation (done)

| # | Feature | Where |
|---|---|---|
| 24 | Live GPS navigation + ride simulator (1× / 10× / 50× / 500×) gliding along the exact road geometry, follow camera with tilt, Screen Wake Lock | `src/nav/navigator.ts`, `NavPanel.tsx` |
| 25 | Off-route alarm (25–200 m, beep + voice, repeats while off), auto-arrival (15–100 m) advancing Next Stop #, missed-stop detection | `navigator.ts`, `audio.ts` |
| 26 | Google Maps backup: exact stop order in 10-leg two-wheeler links (origin + 9 waypoints + destination), list + .csv | `src/nav/gmaps.ts`, Ride tab |
| — | Ride logs with UTC timestamp per GPS point → “Covered” distance, timestamped GPX 1.1 export | `src/nav/rides.ts` |

## Expedition vs Daily modes (step 1, done)

| Area | Expedition (record attempt) | Daily ride |
|---|---|---|
| Points | **Waypoints** pin the exact roads, passed silently; missed waypoint = alarm | Real stops with arrival announcements |
| Off route | **Detour mode**: departure point remembered, proximity guard keeps ≥ 30 m (20–100) from every other planned road incl. crossings, sub-roads, flyovers/subways and parallel carriageways; *Return the way I came* or *Safe way back* (Valhalla with no-go strips, double-checked) | Auto re-route to next stop |
| Logbook | Log stop (overnight / police signature / fuel / other) with GPS, UTC time, odometer, photos; automatic breaks; daily summary; evidence pack .zip (logbook.csv, daily_summary.csv, timestamped GPX, photos) | same |
| Planning | **Route checker**: scans the whole route against itself for crossings, repeated road, < gap proximity and parallel roads | — |

Code: `src/nav/spatial.ts` (segment grid index), `src/nav/detour.ts`, `src/nav/checker.ts`, `src/nav/logbook.ts`, `src/core/terms.ts`.
Rules are built from publicly known Guinness requirements; thresholds are settings and will be aligned with the official guideline document when received.

## Daily mode (step 2, done)

- **Search**: “Where to?” box with Fuel / Police / Hotel / Hospital / Mechanic / Food quick buttons. Google Places when Google mode is on, otherwise Photon (OpenStreetMap, free).
- **Place card**: Directions (live-traffic ETA), Go, Simulate, Add as stop, Google Maps. In Expedition mode: **Safety check** — a route to the place that keeps the gap from every other planned road.
- **Faster routes**: while navigating a Daily ride with Google mode, every 1 / 2 / 5 min the current route is priced against Google's best two-wheeler route; “Faster route available, saves N min” → Take it / Ignore.
- **Live ETA** from Google traffic; traffic layer refreshes every 1 min during Daily navigation (10 min otherwise).

## Android app

Capacitor shell loading the live web app (`capacitor.config.ts`), so web updates reach the app automatically. Native: background GPS foreground service, fake-GPS (mock location) blocking, camera. APK built by `.github/workflows/android.yml` → https://github.com/lonesoull/ridegrid-india/releases/download/android-latest/RideGrid-India.apk

## Team link (step 3, done)

Up to 10 devices (2 phones + laptop in practice), paired with a 25-character code. End-to-end AES-256-GCM over a free public MQTT relay (`wss://broker.emqx.io:8084/mqtt`, configurable) — the relay only sees random bytes.
- Live position / speed / heading / battery / navigation state ~1/sec while riding (retained, so a device joining later sees it immediately); positions buffered offline and sent on reconnect.
- Laptop **mirror panel**: turn, next waypoint, speed, ETA, off-route / proximity alerts of the riding phone; follow camera.
- **Route push** (gzip, chunked, encrypted) with load / replace / ignore prompt; **SOS** (hold 1.5 s while riding) with alarm + “I'm responding”; logged stops shown to the team.
Code: `src/team/` (crypto, team, telemetry, actions), `src/ui/TeamTab.tsx`, `MirrorPanel.tsx`, `TeamModals.tsx`.

## Guinness / India rules (step 4, done)

Data: `tools/build-data.mjs` + `.github/workflows/data.yml` filter the Geofabrik India extract with osmium (two-wheeler-banned motorways/expressways, ~17,000 km) and simplify Natural Earth state boundaries (36 states/UTs); published to the `india-data` release and fetched by the site build.
- **#30 Expressway blocker**: OSRM `exclude=motorway`, Valhalla `use_highways: 0`, Route checker flags legs on banned roads (+ one-tap re-route), live alarm, dark-red map layer.
- **#31 Permit zones / night closures**: ILP states, Ladakh & Sikkim protected areas; curated night-closed forest roads with ETA check.
- **#32 48-hour halt timer** (configurable hours / radius) with escalating alerts.
- **#33 Speed monitor**: 80 km/h on National Highways, 60 elsewhere (configurable).
- **#34 State-by-state** planned vs covered km.
- **#28 Ridden-road layer** (crimson) from all real GPS rides; **#29 dead-end spur (U-turn) detector** in the Route checker.

## Next phases

3. On-device offline router (per-state road graphs) + Guinness/India compliance modules
4. Supabase live telemetry for ≤10 devices, route push, offline POIs, SOS
5. Packaging: Android APK (Capacitor), desktop (Tauri), iOS PWA
