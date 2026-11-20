import { useEffect, useState } from 'react';
import { engine, type Stop } from '../core/engine';
import { db, uid } from '../core/db';
import { cacheKey } from '../core/engine';
import { encode6, haversine, fmtKm, type LngLat } from '../core/geo';
import { device } from '../route/device';
import { buildRouteLine, pointAt } from '../nav/routeLine';
import { mapCtl } from '../ui/App';
import { act, toast, ui } from '../ui/state';
import { dailyNav, type DailyNavSettings, type VoiceLang } from './dailyNav';
import { VOICE_LABEL } from './voice';
import { elevations } from './mapLayers';
import { googleReady, googleElevations, roadTimes } from './gfeatures';
import { weatherAt, weatherText } from './weather';
import { offlineMaps } from './offlineMap';
import { say } from '../nav/audio';
import { AlongRoute } from './AlongRoute';
import { engines } from './engines';
import { app } from '../core/app';

/** Daily ride "Navigation settings": route options, avoided roads, voice, alerts, sort stops, follow track, route details. */
export function DailyRouteSettings() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((x) => x + 1); dailyNav.listeners.add(f); return () => { dailyNav.listeners.delete(f); }; }, []);
  const s = dailyNav.s;
  const save = (p: Partial<DailyNavSettings>) => act(null, () => dailyNav.save(p));
  const r = s.route;
  return (
    <>
      <AlongRoute />
      <section>
        <h3>Route options</h3>
        {([['avoidMotorway', 'Avoid expressways / motorways'], ['avoidToll', 'Avoid toll roads'], ['avoidFerry', 'Avoid ferries'], ['avoidUnpaved', 'Avoid unpaved roads'], ['shortest', 'Shortest route (instead of fastest)']] as const).map(([k, l]) => (
          <label key={k} className="check"><input type="checkbox" checked={r[k]} onChange={(e) => save({ route: { ...r, [k]: e.target.checked } })} /><span>{l}</span></label>
        ))}
        <p className="muted">Changing an option re-plans every leg of this ride. Unpaved avoidance uses the Valhalla engine; offline routing knows expressways but not tolls or surfaces.</p>
        <ExtraEngines />
      </section>

      <AvoidRoads />

      <section>
        <h3>Plan tools</h3>
        <div className="btns">
          <button disabled={engine.stops.length < 4} onClick={() => act('Sorting stops…', () => sortStops(false))}>Sort stops (best order)</button>
          <button disabled={engine.stops.length < 4} onClick={() => act('Sorting stops…', () => sortStops(true))}>Sort, keep last stop last</button>
        </div>
        <label className="photo-btn">
          <input type="file" accept=".gpx,application/gpx+xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void act('Loading track…', () => followTrack(f)); e.target.value = ''; }} />
          🧭 Follow a GPX track (navigate exactly along it)
        </label>
      </section>

      <RouteDetails />

      <section>
        <h3>Voice & alerts</h3>
        <label className="field">Voice language
          <select value={s.voice} onChange={(e) => save({ voice: e.target.value as VoiceLang })}>
            {Object.entries(VOICE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </label>
        <button className="sm" onClick={() => say('In 300 metres, turn left onto MG Road')}>▶ Test voice</button>
        <p className="muted">Uses your phone's own voice for that language (Android: Settings → Text-to-speech → install the language).</p>
        <label className="check"><input type="checkbox" checked={s.autoZoom} onChange={(e) => save({ autoZoom: e.target.checked })} /><span>Auto-zoom map by speed</span></label>
        <div className="grid2">
          {([['camera', '📷 Speed cameras'], ['bump', '⛰ Speed breakers'], ['rail', '🚂 Railway crossings'], ['toll', '💰 Toll plazas'], ['signals', '🚦 Traffic signals'], ['zebra', '🚸 Pedestrian crossings'], ['stop', '🛑 Stop signs'], ['hazard', '⚠️ Hazards'], ['speed', '🔴 Over the speed limit']] as const).map(([k, l]) => (
            <label key={k} className="check"><input type="checkbox" checked={s.alerts[k]} onChange={(e) => save({ alerts: { ...s.alerts, [k]: e.target.checked } })} /><span>{l}</span></label>
          ))}
        </div>
        <div className="muted">Announce places ahead:</div>
        <div className="grid2">
          {([['fuel', '⛽ Petrol pumps'], ['food', '🍛 Restaurants'], ['mechanic', '🔧 Mechanics'], ['favourites', '★ My favourites']] as const).map(([k, l]) => (
            <label key={k} className="check"><input type="checkbox" checked={s.ahead[k]} onChange={(e) => save({ ahead: { ...s.ahead, [k]: e.target.checked } })} /><span>{l}</span></label>
          ))}
        </div>
        <label className="field">Speed warning above the limit by <b>{s.speedTolerance} km/h</b>
          <input type="range" min={0} max={20} value={s.speedTolerance} onChange={(e) => save({ speedTolerance: +e.target.value })} />
        </label>
        <p className="muted">Alerts and speed limits come from the downloaded search & road-alert data and offline maps (Map tab).</p>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- avoid specific roads
function AvoidRoads() {
  const s = dailyNav.s;
  const [picking, setPicking] = useState(false);
  const pick = () => {
    const m = mapCtl?.map;
    if (!m) return;
    const before = ui.get().tapMode;
    ui.set({ tapMode: 'off', drawer: false });
    setPicking(true);
    toast('Tap the road to avoid');
    m.once('click', (e) => void act('Finding the road…', async () => {
      ui.set({ tapMode: before });
      setPicking(false);
      const p: LngLat = [e.lngLat.lng, e.lngLat.lat];
      const road = (await device.roadAt(p, 60, true)) ?? (await onlineRoadAt(p));
      if (!road?.coords?.length) throw new Error('No road found there');
      await dailyNav.save({ avoided: [...s.avoided, { id: uid(), name: road.name || 'Unnamed road', coords: road.coords, at: Date.now() }] });
      toast(`Avoiding ${road.name || 'that road'} — routes are re-planned`);
    }));
  };
  return (
    <section>
      <h3>Roads to avoid</h3>
      {!s.avoided.length && <p className="muted">None. Pick a road on the map and routes will go around it (OsmAnd “Avoid roads”).</p>}
      {s.avoided.map((a) => (
        <div key={a.id} className="item"><div><b>{a.name}</b><div className="muted">{fmtKm(a.coords.slice(1).reduce((m, p, i) => m + haversine(a.coords[i], p), 0))} of road</div></div>
          <div className="btns sm">
            <button onClick={() => { mapCtl?.map.fitBounds([[Math.min(...a.coords.map((c) => c[0])), Math.min(...a.coords.map((c) => c[1]))], [Math.max(...a.coords.map((c) => c[0])), Math.max(...a.coords.map((c) => c[1]))]], { padding: 80 }); ui.set({ drawer: false }); }}>Show</button>
            <button onClick={() => void act(null, () => dailyNav.save({ avoided: s.avoided.filter((x) => x.id !== a.id) }))}>Remove</button>
          </div></div>
      ))}
      <button disabled={picking} onClick={pick}>{picking ? 'Tap a road on the map…' : '+ Pick a road on the map'}</button>
    </section>
  );
}

async function onlineRoadAt(p: LngLat): Promise<{ name: string; coords: LngLat[] } | null> {
  const r = await fetch('https://valhalla1.openstreetmap.de/locate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locations: [{ lon: p[0], lat: p[1] }], costing: 'motorcycle', verbose: true }) }).then((x) => x.json()).catch(() => null);
  const e = r?.[0]?.edges?.[0];
  if (!e?.edge_info?.shape) return null;
  const { decode6 } = await import('../core/geo');
  return { name: (e.edge_info.names ?? []).join(' · '), coords: decode6(e.edge_info.shape) };
}

// ---------------------------------------------------------------- sort stops (nearest neighbour + 2-opt)
async function sortStops(keepLast: boolean) {
  const S = engine.stops.slice();
  // Google real two-wheeler road times with traffic when possible; straight-line distance otherwise
  let d = (a: Stop, b: Stop) => haversine([a.lng, a.lat], [b.lng, b.lat]);
  let by = 'straight-line distance';
  if (googleReady() && S.length <= 25) {
    try {
      const m = await roadTimes(S.map((x) => [x.lng, x.lat] as LngLat));
      const ix = new Map(S.map((x, i) => [x.id, i]));
      d = (a, b) => m[ix.get(a.id)!][ix.get(b.id)!];
      by = 'Google road time with traffic';
    } catch { /* cap reached / offline → straight line */ }
  }
  const first = S[0], last = keepLast ? S[S.length - 1] : null;
  const rest = S.slice(1, keepLast ? -1 : undefined);
  const order: Stop[] = [first];
  while (rest.length) {
    const cur = order[order.length - 1];
    let bi = 0;
    for (let i = 1; i < rest.length; i++) if (d(cur, rest[i]) < d(cur, rest[bi])) bi = i;
    order.push(rest.splice(bi, 1)[0]);
  }
  if (last) order.push(last);
  // 2-opt improvement (first and fixed last stay put)
  const end = order.length - (last ? 1 : 0);
  for (let pass = 0, improved = true; improved && pass < 30; pass++) {
    improved = false;
    for (let i = 1; i < end - 1; i++) for (let k = i + 1; k < end; k++) {
      const a = order[i - 1], b = order[i], c = order[k], e = order[k + 1];
      const before = d(a, b) + (e ? d(c, e) : 0), after = d(a, c) + (e ? d(b, e) : 0);
      if (after + 1 < before) { order.splice(i, k - i + 1, ...order.slice(i, k + 1).reverse()); improved = true; }
    }
  }
  const saved = S.reduce((m, s, i) => (i ? m + d(S[i - 1], s) : 0), 0) - order.reduce((m, s, i) => (i ? m + d(order[i - 1], s) : 0), 0);
  await engine.replaceAll(order);
  toast(saved > (by.startsWith('Google') ? 30 : 50) ? `Stops re-ordered by ${by}${by.startsWith('Google') ? ` — about ${Math.round(saved / 60)} min quicker` : ` — about ${fmtKm(saved)} shorter`}. Undo restores the old order.` : 'Already in a good order');
}

// ---------------------------------------------------------------- follow a GPX track
async function followTrack(f: File) {
  const xml = new DOMParser().parseFromString(await f.text(), 'application/xml');
  const pts: LngLat[] = [...xml.querySelectorAll('trkpt, rtept')].map((n) => [+n.getAttribute('lon')!, +n.getAttribute('lat')!] as LngLat).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) throw new Error('No track points in this GPX');
  // one leg whose road geometry IS the track (stored in the route cache, so it is never re-routed)
  const a: Stop = { id: uid(), lng: pts[0][0], lat: pts[0][1], name: 'Track start' }, b: Stop = { id: uid(), lng: pts[pts.length - 1][0], lat: pts[pts.length - 1][1], name: 'Track end' };
  const distM = pts.slice(1).reduce((m, p, i) => m + haversine(pts[i], p), 0);
  const { deriveTurns } = await import('../nav/detour');
  await db.legs.put({ key: cacheKey(pts[0], pts[pts.length - 1]), poly: encode6(pts), distM, turns: deriveTurns(pts), provider: 'gpx-track', at: Date.now() } as any);
  if (engine.stops.length && !confirm(`Replace this ride's ${engine.stops.length} stops with the track “${f.name}”?`)) return;
  await engine.replaceAll([a, b]);
  setTimeout(() => mapCtl?.fitRoute(), 400);
  toast(`Following track: ${fmtKm(distM)}. Start navigation from the Navigate tab.`);
}

// ---------------------------------------------------------------- route details: elevation, weather, missing maps
function RouteDetails() {
  const [d, setD] = useState<null | { prof: number[]; total: number; up: number; down: number; min: number; max: number; wx: { at: number; km: number; txt: string }[]; noMap: number }>(null);
  const run = () => act('Analysing route…', async () => {
    const L = buildRouteLine();
    if (L.n < 2 || L.total < 100) throw new Error('Plan a route first');
    const N = 160, pts: LngLat[] = [];
    for (let i = 0; i <= N; i++) pts.push(pointAt(L, (L.total * i) / N).p);
    // Google elevation first (online), our terrain data otherwise
    let ele: number[];
    try { if (!googleReady()) throw new Error('offline'); ele = await googleElevations(pts, pts.length); }
    catch { ele = (await elevations(pts)).map((v) => (Number.isFinite(v) ? v : NaN)); }
    let up = 0, down = 0;
    for (let i = 1; i < ele.length; i++) { const dz = ele[i] - ele[i - 1]; if (Number.isFinite(dz)) { if (dz > 0) up += dz; else down -= dz; } }
    const ok = ele.filter(Number.isFinite);
    // weather at 5 points along the way, at the time you'd be there (~40 km/h average)
    const wx: { at: number; km: number; txt: string }[] = [];
    for (let k = 0; k < 5; k++) {
      const s = (L.total * k) / 4, p = pointAt(L, s).p, at = Date.now() + (s / (40 / 3.6)) * 1000;
      const w = await weatherAt(p, 48);
      const h = w?.hours.reduce((b, x) => (Math.abs(x.t - at) < Math.abs(b.t - at) ? x : b), w.hours[0]);
      if (h) wx.push({ at, km: s / 1000, txt: `${weatherText(h.code)} ${Math.round(h.temp)}°C · rain ${h.rainPct}%` });
    }
    const noMap = pts.filter((p) => !offlineMaps.covers(p[0], p[1])).length / pts.length;
    setD({ prof: ele, total: L.total, up, down, min: Math.min(...ok), max: Math.max(...ok), wx, noMap });
  });
  return (
    <section>
      <h3>Route details</h3>
      <button onClick={run}>Analyse this route (elevation, weather, maps)</button>
      {d && <>
        <p><b>{fmtKm(d.total)}</b> · ↗ {Math.round(d.up)} m climb · ↘ {Math.round(d.down)} m descent · {Math.round(d.min)}–{Math.round(d.max)} m altitude</p>
        <Profile ele={d.prof} />
        {d.wx.length > 0 && <div className="muted">{d.wx.map((w) => <div key={w.km}>{w.km.toFixed(0)} km ({new Date(w.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}): {w.txt}</div>)}</div>}
        {d.noMap > 0.05 && <p className="warn">{Math.round(d.noMap * 100)}% of this route is outside your downloaded offline maps — download those regions in the Map tab before riding without internet.</p>}
      </>}
    </section>
  );
}

function Profile({ ele }: { ele: number[] }) {
  const ok = ele.filter(Number.isFinite);
  if (ok.length < 2) return <p className="muted">Elevation needs internet (terrain tiles).</p>;
  const min = Math.min(...ok), max = Math.max(...ok), W = 320, H = 90, span = Math.max(20, max - min);
  const pts = ele.map((v, i) => `${(i / (ele.length - 1)) * W},${Number.isFinite(v) ? H - ((v - min) / span) * (H - 8) - 4 : H}`).join(' ');
  return (
    <svg className="profile" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Elevation profile">
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill="rgba(10,132,255,.18)" />
      <polyline points={pts} fill="none" stroke="#0a84ff" strokeWidth="2" />
    </svg>
  );
}

/** GraphHopper / OpenRouteService as extra Daily routers (free keys; Google stays first when it is on). */
export function ExtraEngines() {
  const [gh, setGh] = useState(engines.ghKey);
  const [ors, setOrs] = useState(engines.orsKey);
  const save = () => act(null, async () => { engines.ghKey = gh; engines.orsKey = ors; await app.setRouter(app.router); toast('Routing engines updated'); });
  return (
    <details>
      <summary>More routing engines (GraphHopper, OpenRouteService)</summary>
      <p className="hint">Used only for Daily rides, alongside the others, when Google routing is off, paused or out of free routes. Free keys: graphhopper.com (500 requests a day) and openrouteservice.org (2,000 a day). Keys stay on this device.</p>
      <label className="field">GraphHopper key<input value={gh} onChange={(e) => setGh(e.target.value)} autoComplete="off" /></label>
      <label className="field">OpenRouteService key<input value={ors} onChange={(e) => setOrs(e.target.value)} autoComplete="off" /></label>
      <button onClick={save}>Save</button>
    </details>
  );
}
