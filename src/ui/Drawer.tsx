import { useEffect, useRef, useState } from 'react';
import { T, isExpedition } from '../core/terms';
import { RouteChecker } from './RouteChecker';
import { OfflineRouting } from './OfflineRouting';
import { stateBreakdown, type StateKm } from '../nav/states';
import { buildRouteLine } from '../nav/routeLine';
import { ILP_STATES } from '../nav/compliance';
import { isNativeApp, openAppSettings } from '../nav/gps';
import { engine } from '../core/engine';
import { app, DEFAULT_ROUTER, type RouterSettings } from '../core/app';
import { db } from '../core/db';
import { fmtKm, type LngLat } from '../core/geo';
import * as trips from '../core/trips';
import { importFile, parseCoordinateText, type ImportOptions } from '../io/importers';
import { download, exportAs, safeName } from '../io/exporters';
import { ui, useUI, toast, act } from './state';
import { useAsync, useEngine, useRouterStatus } from './hooks';
import { mapCtl } from './App';
import { StressRouteButton } from './StressRouteButton';
import { google, testGoogleKey, type KeyTest } from '../core/google';
import { applyBase } from '../map/googleBase';
import { RideTab } from './RideTab';
import { LogbookTab } from './LogbookTab';
import { mode, MODE_LABEL } from '../core/mode';
import { DailyMapTab } from '../daily/DailyMapTab';
import { PlacesTab } from '../daily/PlacesTab';
import { TracksTab } from '../daily/TracksTab';
import { DailyControl } from '../daily/DailyControl';
import { GoogleUsage } from './GoogleUsage';
import { TeamTab } from './TeamTab';

export function Drawer() {
  const open = useUI((s) => s.drawer);
  const tab = useUI((s) => s.tab);
  return (
    <>
      <div className={`scrim ${open ? 'on' : ''}`} onClick={() => ui.set({ drawer: false })} />
      <aside className={`drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
        <div className="drawer-head">
          <b>RideGrid India</b>
          <button className={`modebtn ${mode.current}`} onClick={() => ui.set({ modePicker: true })}>{MODE_LABEL[mode.current]} ⇄</button>
          <button className="x" onClick={() => ui.set({ drawer: false })}>✕</button>
        </div>
        <nav className="tabs">
          {(mode.current === 'daily' ? ['trip', 'stops', 'ride', 'map', 'places', 'tracks', 'log', 'team', 'files', 'tools'] as const : ['trip', 'stops', 'ride', 'log', 'team', 'files', 'tools'] as const).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => ui.set({ tab: t })}>
              {(mode.current === 'daily'
                ? { trip: 'Rides', stops: 'Stops', ride: 'Navigate', map: 'Map', places: 'Places', tracks: 'Tracks', log: 'Diary', team: 'Team', files: 'Files', tools: 'Tools' } as Record<string, string>
                : { trip: 'Trip', stops: T().Many, ride: 'Ride', log: 'Logbook', team: 'Team', files: 'Files', tools: 'Tools' } as Record<string, string>)[t]}
            </button>
          ))}
        </nav>
        <div className="drawer-body">
          {open && tab === 'trip' && <TripTab />}
          {open && tab === 'stops' && <StopsTab />}
          {open && tab === 'ride' && <RideTab />}
          {open && tab === 'map' && mode.current === 'daily' && <DailyMapTab />}
          {open && tab === 'places' && mode.current === 'daily' && <PlacesTab />}
          {open && tab === 'tracks' && mode.current === 'daily' && <TracksTab />}
          {open && tab === 'log' && <LogbookTab />}
          {open && tab === 'team' && <TeamTab />}
          {open && tab === 'files' && <FilesTab />}
          {open && tab === 'tools' && <ToolsTab />}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------- Trip
function TripTab() {
  useEngine();
  const t = engine.trip!;
  const [list, reload] = useAsync(() => trips.listModeTrips(), [t.id]);
  const daily = mode.current === 'daily';
  const [routes, reloadRoutes] = useAsync(() => trips.listRoutes(t.id), [t.id, t.draftSourceRouteId]);
  const [newName, setNewName] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const source = routes?.find((r) => r.id === t.draftSourceRouteId);
  const covered = t.coveredM, target = (t.targetKm ?? 0) * 1000;

  return (
    <div className="stack">
      <section>
        <h3>{daily ? 'Active ride plan' : 'Active trip'}</h3>
        <select value={t.id} onChange={(e) => act('Loading trip…', () => trips.switchTrip(e.target.value))}>
          {list?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <div className="grid3">
          <Stat label="Mapped" v={fmtKm(engine.routedM)} />
          <Stat label="Covered" v={fmtKm(covered)} />
          <Stat label="Left" v={target ? fmtKm(Math.max(0, target - covered)) : '—'} />
        </div>
        {target > 0 && <div className="bar"><div style={{ width: `${Math.min(100, (covered / target) * 100)}%` }} /><div className="plan" style={{ width: `${Math.min(100, (engine.routedM / target) * 100)}%` }} /></div>}
        <label className="field">Trip name
          <input defaultValue={t.name} key={t.id + 'n'} onBlur={(e) => e.target.value.trim() && act(null, () => engine.updateTrip({ name: e.target.value.trim() })).then(reload)} />
        </label>
        <label className="field">Distance target (km, optional)
          <input type="number" inputMode="numeric" defaultValue={t.targetKm ?? ''} key={t.id + 't'} onBlur={(e) => act(null, () => engine.updateTrip({ targetKm: e.target.value ? +e.target.value : undefined }))} />
        </label>
        {!daily && <label className="check">
          <input type="checkbox" checked={t.sequenceLock} onChange={(e) => act(null, () => engine.updateTrip({ sequenceLock: e.target.checked }))} />
          <span><b>Sequence Lock</b> — keep points exactly in the order I mapped them (#1 → #2 → #3…). Blocks reverse and any reordering.</span>
        </label>}
      </section>

      {!daily && <StateTracker />}

      <section>
        <h3>Working draft <span className="pill">auto-saved</span></h3>
        <p className="muted">{engine.stops.length.toLocaleString('en-IN')} {T().n(engine.stops.length)} · {source ? <>from “{source.name}”</> : 'not saved to library yet'}</p>
        <div className="btns">
          <button onClick={() => { const n = prompt('Route name', source ? `${source.name} v2` : `Route ${new Date().toLocaleDateString('en-IN')}`); if (n) void act(null, () => trips.saveDraftAsRoute(n)).then(() => { reloadRoutes(); toast('Saved to library'); }); }}>Save as new route</button>
          {source && <button onClick={() => act(null, () => trips.overwriteRoute(source.id)).then(() => { reloadRoutes(); toast(`Updated “${source.name}”`); })}>Update “{source.name}”</button>}
          <button className="danger" onClick={() => confirm(source ? `Discard draft edits and go back to “${source.name}”?` : 'Discard the working draft?') && act(null, () => trips.exitDraft())}>Exit draft</button>
        </div>
      </section>

      <section>
        <h3>Saved routes library</h3>
        {!routes?.length && <p className="muted">No saved routes yet.</p>}
        {routes?.map((r) => (
          <div key={r.id} className={`item ${r.id === t.draftSourceRouteId ? 'cur' : ''}`}>
            <div><b>{r.name}</b><div className="muted">{r.stops.length.toLocaleString('en-IN')} stops · {fmtKm(r.distM)} · {new Date(r.createdAt).toLocaleString('en-IN')}</div></div>
            <div className="btns sm">
              <button onClick={() => act('Opening route…', () => trips.openRouteInDraft(r.id)).then(() => setTimeout(() => mapCtl?.fitRoute(), 300))}>Continue</button>
              <button onClick={() => act(null, () => trips.duplicateRoute(r.id)).then(reloadRoutes)}>Duplicate</button>
              <button onClick={() => { const n = prompt('Rename route', r.name); if (n) void trips.renameRoute(r.id, n).then(reloadRoutes); }}>Rename</button>
              <button className="danger" onClick={() => confirm(`Delete “${r.name}”?`) && trips.deleteRoute(r.id).then(reloadRoutes)}>Delete</button>
            </div>
          </div>
        ))}
      </section>

      <section>
        <h3>{daily ? 'New ride plan' : 'New expedition trip'}</h3>
        <input placeholder={daily ? 'Ride name (e.g. Office, Weekend to Nandi Hills)' : 'Trip name'} value={newName} onChange={(e) => setNewName(e.target.value)} />
        <input placeholder="Target km (optional)" type="number" inputMode="numeric" value={newTarget} onChange={(e) => setNewTarget(e.target.value)} />
        <div className="btns">
          <button className="primary" disabled={!newName.trim()} onClick={() => act(null, async () => {
            const nt = await trips.createTrip(newName.trim(), newTarget ? +newTarget : undefined, mode.current);
            await trips.switchTrip(nt.id); setNewName(''); setNewTarget(''); reload();
          })}>Create & switch</button>
          {(list?.length ?? 0) > 1 && <button className="danger" onClick={() => confirm(`Delete trip “${t.name}” with all its routes and history?`) && act(null, async () => {
            await trips.deleteTrip(t.id); const rest = await trips.listModeTrips(); await trips.switchTrip(rest[0].id); reload();
          })}>Delete this trip</button>}
        </div>
      </section>
    </div>
  );
}

const Stat = ({ label, v }: { label: string; v: string }) => <div className="stat"><div className="muted">{label}</div><b>{v}</b></div>;

// ---------------------------------------------------------------- Stops
const PAGE = 100;
function StopsTab() {
  useEngine();
  const n = engine.stops.length;
  const [page, setPage] = useState(0);
  const [jump, setJump] = useState('');
  const [lat, setLat] = useState(''); const [lng, setLng] = useState(''); const [nm, setNm] = useState(''); const [pos, setPos] = useState('');
  const [paste, setPaste] = useState(''); const [lngFirst, setLngFirst] = useState(false);
  const pages = Math.max(1, Math.ceil(n / PAGE));
  const pg = Math.min(page, pages - 1);
  const rows = engine.stops.slice(pg * PAGE, pg * PAGE + PAGE);
  const legsByA = useRef(new Map<string, number>());
  legsByA.current = new Map();
  for (const l of engine.legs.values()) if (l.status === 'ok') legsByA.current.set(l.a, l.distM);
  const locked = engine.trip?.sequenceLock;
  const parsed = paste ? parseCoordinateText(paste, lngFirst) : [];

  const addOne = () => {
    const la = parseFloat(lat), lo = parseFloat(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) { toast('Enter a valid latitude and longitude', 'error'); return; }
    const at = pos ? Math.max(0, Math.min(n, parseInt(pos) - 1)) : n;
    void act(null, () => engine.addStop([lo, la], at, nm || undefined)).then(() => { setLat(''); setLng(''); setNm(''); setPos(''); mapCtl?.flyToStop(at); });
  };

  return (
    <div className="stack">
      {isExpedition() && <RouteChecker />}
      <section>
        <h3>Route tools</h3>
        <div className="btns">
          <button onClick={() => mapCtl?.fitRoute()}>Fit route bounds</button>
          <button onClick={() => mapCtl?.snapView()}>Snap view</button>
          <button disabled={!!locked || n < 2} title={locked ? 'Sequence Lock is on' : ''} onClick={() => act(null, () => engine.reverse())}>Reverse order{locked ? ' 🔒' : ''}</button>
          <button className="danger" disabled={!n} onClick={() => confirm(`Clear all ${n.toLocaleString('en-IN')} stops? (You can undo.)`) && act(null, () => engine.clear())}>Clear all</button>
        </div>
      </section>

      <section>
        <h3>Add {T().one} by coordinates</h3>
        <div className="grid2">
          <input placeholder="Latitude e.g. 28.613939" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
          <input placeholder="Longitude e.g. 77.209023" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />
          <input placeholder="Name (optional)" value={nm} onChange={(e) => setNm(e.target.value)} />
          <input placeholder={`Insert at # (default ${n + 1})`} inputMode="numeric" value={pos} onChange={(e) => setPos(e.target.value)} />
        </div>
        <button className="primary" onClick={addOne}>Add {T().one}</button>
      </section>

      <section>
        <h3>Paste coordinate list</h3>
        <textarea rows={5} placeholder={'One per line:\n28.613939, 77.209023, India Gate\n27.175015 78.042155'} value={paste} onChange={(e) => setPaste(e.target.value)} />
        <label className="check"><input type="checkbox" checked={lngFirst} onChange={(e) => setLngFirst(e.target.checked)} /><span>Lines are “longitude, latitude”</span></label>
        <button className="primary" disabled={!parsed.length} onClick={() => act(`Adding ${parsed.length} stops…`, () => engine.addMany(parsed)).then(() => { setPaste(''); toast(`Added ${parsed.length} stops`); mapCtl?.fitRoute(); })}>
          Append {parsed.length ? parsed.length.toLocaleString('en-IN') : ''} stops
        </button>
      </section>

      <section>
        <h3>{T().One} inspector <span className="muted">({n.toLocaleString('en-IN')})</span></h3>
        <div className="pager">
          <button disabled={pg === 0} onClick={() => setPage(pg - 1)}>◀ Prev 100</button>
          <span>{n ? `${(pg * PAGE + 1).toLocaleString('en-IN')}–${Math.min(n, pg * PAGE + PAGE).toLocaleString('en-IN')}` : '0'}</span>
          <button disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next 100 ▶</button>
        </div>
        <div className="row">
          <input placeholder="Jump to stop #" inputMode="numeric" value={jump} onChange={(e) => setJump(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.nextSibling as HTMLButtonElement)?.click()} />
          <button onClick={() => { const k = parseInt(jump) - 1; if (k >= 0 && k < n) { setPage(Math.floor(k / PAGE)); mapCtl?.flyToStop(k); ui.set({ drawer: false }); } else toast(`No such ${T().one}`, 'error'); }}>Go</button>
        </div>
        <div className="list">
          {rows.map((s, j) => {
            const i = pg * PAGE + j;
            const d = legsByA.current.get(s.id);
            return (
              <div className="item tight" key={s.id}>
                <button className="link" onClick={() => { mapCtl?.flyToStop(i); ui.set({ drawer: false }); }}>
                  <b>#{(i + 1).toLocaleString('en-IN')}</b> {s.name ?? ''}
                  <div className="muted">{s.lat.toFixed(5)}, {s.lng.toFixed(5)}{d !== undefined ? ` · next leg ${fmtKm(d)}` : ''}</div>
                </button>
                <button className="danger sm" onClick={() => act(null, () => engine.deleteStop(s.id))}>✕</button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Files
function FilesTab() {
  useEngine();
  const t = engine.trip!;
  const [opt, setOpt] = useState<ImportOptions>({ trackSampleM: 1000, prefer: 'auto' });
  const [log, setLog] = useState<string[]>([]);
  const [withCache, setWithCache] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const backupRef = useRef<HTMLInputElement>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const all: { p: LngLat; name?: string }[] = []; const lines: string[] = [];
    await act(`Reading ${files.length} file(s)…`, async () => {
      for (const f of Array.from(files)) {
        try { const r = await importFile(f, opt); all.push(...r.stops); lines.push(`✓ ${r.file}: ${r.stops.length.toLocaleString('en-IN')} stops (${r.note})`); }
        catch (e: any) { lines.push(`✗ ${f.name}: ${e.message || e}`); }
      }
      if (all.length) await engine.addMany(all);
    });
    setLog(lines);
    if (all.length) { toast(`Imported ${all.length.toLocaleString('en-IN')} stops (one undo step)`); setTimeout(() => mapCtl?.fitRoute(), 300); }
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="stack">
      <section>
        <h3>Bulk import</h3>
        <p className="muted">GPX · KML · KMZ · GeoJSON · CSV · XLSX · FIT · TCX — select many files at once. Stops are appended in file order.</p>
        <div className="grid2">
          <label className="field">Tracks become stops every
            <select value={opt.trackSampleM} onChange={(e) => setOpt({ ...opt, trackSampleM: +e.target.value })}>
              {[250, 500, 1000, 2000, 5000, 10000].map((m) => <option key={m} value={m}>{m >= 1000 ? `${m / 1000} km` : `${m} m`}</option>)}
            </select>
          </label>
          <label className="field">Use
            <select value={opt.prefer} onChange={(e) => setOpt({ ...opt, prefer: e.target.value as ImportOptions['prefer'] })}>
              <option value="auto">Waypoints, else track</option>
              <option value="points">Waypoints only</option>
              <option value="track">Track only</option>
            </select>
          </label>
        </div>
        <input ref={fileRef} type="file" multiple hidden accept=".gpx,.kml,.kmz,.geojson,.json,.csv,.txt,.xlsx,.xls,.fit,.tcx" onChange={(e) => onFiles(e.target.files)} />
        <button className="primary" onClick={() => fileRef.current?.click()}>Choose files…</button>
        {log.length > 0 && <pre className="log">{log.join('\n')}</pre>}
      </section>

      <section>
        <h3>Export</h3>
        <p className="muted">GPX 1.1 (waypoints + stop order + full road track), styled KML with folders, CSV logbook.</p>
        <div className="btns">
          <button disabled={!engine.stops.length} onClick={() => exportAs('gpx', t.name)}>.gpx 1.1</button>
          <button disabled={!engine.stops.length} onClick={() => exportAs('kml', t.name)}>.kml</button>
          <button disabled={!engine.stops.length} onClick={() => exportAs('csv', t.name)}>.csv logbook</button>
        </div>
        {engine.pendingLegs + engine.errorLegs > 0 && <p className="warn">{(engine.pendingLegs + engine.errorLegs).toLocaleString('en-IN')} legs are not road-snapped yet; they are exported separately as “unrouted”.</p>}
      </section>

      <section>
        <h3>Full backup & restore</h3>
        <p className="muted">All trips, saved routes, drafts and undo history in one .json file.</p>
        <label className="check"><input type="checkbox" checked={withCache} onChange={(e) => setWithCache(e.target.checked)} /><span>Include road-geometry cache (bigger file, no re-fetching on the other device)</span></label>
        <div className="btns">
          <button className="primary" onClick={() => act('Building backup…', async () => download(`ridegrid_backup_${safeName(new Date().toISOString().slice(0, 16))}.json`, await trips.exportBackup(withCache)))}>Download backup</button>
          <button onClick={() => backupRef.current?.click()}>Restore…</button>
        </div>
        <input ref={backupRef} type="file" hidden accept=".json,application/json" onChange={async (e) => {
          const f = e.target.files?.[0]; if (!f) return;
          const replace = confirm('Replace everything on this device with the backup?\n\nOK = Replace all   ·   Cancel = Merge (add trips that are not here)');
          await act('Restoring…', () => trips.importBackup(f, replace ? 'replace' : 'merge'));
          toast('Backup restored'); e.target.value = '';
        }} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Tools
function ToolsTab() {
  useEngine();
  const status = useRouterStatus();
  const [r, setR] = useState<RouterSettings>(app.router);
  const snap = useUI((s) => s.snapToRoad);
  const fps = useUI((s) => s.fps);
  const [cacheCount, reloadCache] = useAsync(() => db.legs.count(), []);
  useEffect(() => setR(app.router), []);

  const stress = (k: number) => act(`Generating ${k.toLocaleString('en-IN')} test stops…`, async () => {
    await trips.addStressStops(k);
    ui.set({ fps: true });
    toast(`+${k.toLocaleString('en-IN')} test stops in the separate Stress Test trip. Tap “Map test stops on roads” to road-snap them.`);
  });
  const isStress = !!engine.trip?.isStress;

  return (
    <div className="stack">
      {mode.current === 'daily' && <DailyControl />}
      <section>
        <h3>Road snapping engine</h3>
        <p className="muted">Status: <b>{status}</b> · {engine.pendingLegs.toLocaleString('en-IN')} pending · {engine.errorLegs} failed · {app.queue.requests} requests this session · {cacheCount?.toLocaleString('en-IN') ?? '…'} legs cached on device{app.queue.lastError ? ` · last error: ${app.queue.lastError}` : ''}</p>
        {isStress
          ? <><p className="warn">You are viewing the <b>Stress Test</b> trip. Road mapping starts paused here so thousands of test stops don't flood the free server — start it when you want (paced ~1 request/sec, ~24 stops per request). Your real trips are safe — <b>Back to my trip</b> is below.</p><StressRouteButton className="" /></>
          : <label className="check"><input type="checkbox" checked={app.queue.autoRoute} onChange={(e) => { app.queue.setAuto(e.target.checked); setR({ ...r }); }} /><span>Auto-route new legs (paced, cached, rate-limit safe)</span></label>}
        <label className="check"><input type="checkbox" checked={snap} onChange={(e) => ui.set({ snapToRoad: e.target.checked })} /><span>Snap tapped / dragged stops to the nearest road</span></label>
        <label className="check"><input type="checkbox" checked={r.avoidExpressways !== false} onChange={(e) => setR({ ...r, avoidExpressways: e.target.checked })} /><span>Expedition trips: avoid expressways / motorways (two-wheelers are banned; daily trips may use them) — tap “Save engine”</span></label>
        <div className="grid2">
          <label className="field">Engine
            <select value={r.kind} onChange={(e) => setR({ kind: e.target.value as RouterSettings['kind'], url: e.target.value === 'valhalla' ? 'https://valhalla1.openstreetmap.de' : DEFAULT_ROUTER.url })}>
              <option value="osrm">OSRM (overview=full, Polyline6)</option>
              <option value="valhalla">Valhalla (motorcycle)</option>
            </select>
          </label>
          <label className="field">Server URL
            <input value={r.url} onChange={(e) => setR({ ...r, url: e.target.value.trim() })} />
          </label>
        </div>
        {r.kind === 'osrm' && r.url.includes('project-osrm.org') && (
          <label className="check"><input type="checkbox" checked={r.parallel !== false} onChange={(e) => setR({ ...r, parallel: e.target.checked })} /><span>Also use the second free OSRM server (FOSSGIS) in parallel — about 2× faster</span></label>
        )}
        <p className="muted">Working now: {app.queue.providerLabels.join(' + ')} · ≈{Math.round(app.queue.legsPerSec())} legs/sec</p>
        <div className="btns">
          <button className="primary" onClick={() => act(null, () => app.setRouter(r)).then(() => toast('Routing engine saved'))}>Save engine</button>
          <button onClick={() => { engine.retryErrors(); app.queue.kick(); }}>Retry failed legs</button>
          <button className="danger" onClick={() => confirm('Delete all cached road geometry on this device?') && db.legs.clear().then(reloadCache)}>Clear road cache</button>
        </div>
        <p className="muted">Public servers are free but rate-limited: each is paced to ~1 request/sec with up to 99 legs per request, and every leg is stored forever on this device. Point the URL at your own OSRM/Valhalla anytime.</p>
      </section>

      <OfflineRouting />

      <AndroidAppPanel />

      <GoogleSettingsPanel />
      <GoogleUsage />

      {mode.current === 'expedition' && <section>
        <h3>Scale stress test</h3>
        <p className="muted">Adds random-walk test stops on Indian land inside a separate <b>Stress Test</b> trip, so your real trips are never touched and no routing requests are made. One undo step per batch.</p>
        <div className="btns">
          <button onClick={() => stress(100)}>+100</button>
          <button onClick={() => stress(1000)}>+1,000</button>
          <button onClick={() => stress(10000)}>+10,000</button>
        </div>
        {isStress && (
          <div className="btns">
            <button disabled={!engine.stops.length} onClick={() => confirm(`Clear all ${engine.stops.length.toLocaleString('en-IN')} test stops?`) && act('Clearing…', () => engine.clear())}>Clear test stops</button>
            <button onClick={() => act(null, () => trips.leaveStressTrip()).then(() => setTimeout(() => mapCtl?.fitRoute(), 300))}>← Back to my trip</button>
          </div>
        )}
        <button className="danger" onClick={() => confirm('Clear ALL stress-test stops and delete the Stress Test trip?') && act('Clearing stress test…', () => trips.deleteStressTrip()).then(() => toast('Stress test cleared'))}>Clear all stress tests</button>
        <label className="check"><input type="checkbox" checked={fps} onChange={(e) => ui.set({ fps: e.target.checked })} /><span>Show FPS meter</span></label>
      </section>}

      <section>
        <h3>Storage</h3>
        <StorageInfo />
      </section>
    </div>
  );
}

function StorageInfo() {
  const [est] = useAsync(async () => (navigator.storage?.estimate ? navigator.storage.estimate() : undefined), []);
  const [persisted] = useAsync(async () => (navigator.storage?.persisted ? navigator.storage.persisted() : false), []);
  return <p className="muted">{est ? `${((est.usage ?? 0) / 1048576).toFixed(1)} MB used of ${((est.quota ?? 0) / 1073741824).toFixed(1)} GB available.` : 'Storage estimate unavailable.'} {persisted ? 'Persistent storage granted ✓' : 'Persistent storage not yet granted (install the app to keep data safe).'}</p>;
}


function GoogleSettingsPanel() {
  const [g, setG] = useState(google.settings);
  const [k, setK] = useState(google.settings.key);
  const [tests, setTests] = useState<KeyTest[] | null>(null);
  const save = (p: Partial<typeof g>) => act(null, async () => { setG(await google.save(p)); if (mapCtl) await applyBase(mapCtl, true); });
  return (
    <section>
      <h3>Google Maps mode</h3>
      <p className="muted">Uses your Google Maps Platform key for: Google's map with <b>live traffic</b>, and <b>traffic-aware two-wheeler directions</b> for “from my location” and re-routes.
        Your planned expedition route stays on OSRM (Google allows only 25 waypoints and no long-term storage). Offline, the app switches back to the OpenStreetMap map automatically.</p>
      <input type="password" autoComplete="off" placeholder="Paste Google Maps API key (stays on this device only)" value={k} onChange={(e) => setK(e.target.value.trim())} />
      <div className="btns">
        <button className="primary" disabled={!k || (k === g.key && g.on)} onClick={() => save({ key: k, on: true })}>Save key & turn on</button>
        {g.key && <button onClick={() => save({ on: !g.on })}>{g.on ? 'Turn Google mode off' : 'Turn Google mode on'}</button>}
        {g.key && <button className="danger" onClick={() => { setK(''); void save({ key: '', on: false }); }}>Remove key</button>}
      </div>
      <button disabled={!k} onClick={() => act('Testing the key with Google…', async () => setTests(await testGoogleKey(k)))}>Test key</button>
      {tests && (
        <div className="list">
          {tests.map((t) => (
            <div key={t.api} className={`item ${t.ok ? '' : 'keyfail'}`}>
              <b>{t.ok ? '✅' : '❌'} {t.api}</b>
              {!t.ok && <div className="muted">Google says: {t.message}</div>}
              {t.fix && <div><b>Fix:</b> {t.fix}</div>}
            </div>
          ))}
          {tests.every((t) => t.ok) && <p className="muted">All good — tap “Save key & turn on”.</p>}
          {!tests[0].ok && <p className="muted">The Maps JavaScript API is required for Google mode (Google's map + live traffic); Routes and Places add directions and search.</p>}
        </div>
      )}
      {g.key && g.on && <GoogleStatus />}
      {g.key && (
        <label className="field">Map ID (optional — for 3D tilt, rotation and 3D buildings)
          <div className="row">
            <input placeholder="e.g. 8f348d1b5a61d4bb (leave empty for Google's demo ID)" defaultValue={g.mapId} onBlur={(e) => e.target.value.trim() !== g.mapId && save({ mapId: e.target.value.trim() })} />
          </div>
          <span className="muted">Create one free: Google Cloud console → Google Maps Platform → <b>Map management</b> → Create Map ID → type <b>JavaScript</b>, <b>Vector</b>, tick <b>Tilt</b> and <b>Rotation</b> → copy the Map ID here.</span>
        </label>
      )}
      {g.key && <label className="check"><input type="checkbox" checked={g.traffic} onChange={(e) => save({ traffic: e.target.checked })} /><span>Show live traffic on the map (Google refreshes it automatically)</span></label>}
      <p className="muted small-note">In Google mode your route is drawn with Google's own camera settings, so it stays on Google's roads when rotated or tilted. Route lines © OpenStreetMap contributors (OSRM).</p>
      <details>
        <summary className="muted">How to create the key and keep it at ₹0</summary>
        <ol className="muted small">
          <li>console.cloud.google.com → new project → enable <b>Maps JavaScript API</b>, <b>Routes API</b> and <b>Places API (New)</b> (billing account required).</li>
          <li>Credentials → Create API key → <b>Application restrictions: Websites</b> → add <code>https://lonesoull.github.io/*</code> (and <code>http://localhost:*</code> for testing).</li>
          <li><b>API restrictions</b> → restrict key to Maps JavaScript API + Routes API + Places API (New).</li>
          <li>Quotas: cap requests per day (e.g. Maps JavaScript map loads 1,000/day, Routes 2,000/day, Places 1,000/day) and add a ₹1 budget alert, so usage stays inside the free monthly limits.</li>
        </ol>
      </details>
    </section>
  );
}

const APK_URL = 'https://github.com/lonesoull/ridegrid-india/releases/download/android-latest/RideGrid-India.apk';
function AndroidAppPanel() {
  if (isNativeApp()) {
    return (
      <section>
        <h3>Android app <span className="pill">installed</span></h3>
        <p className="muted">Background GPS is on: rides keep recording with the screen off (a “RideGrid is recording” notification shows while riding).
          App updates arrive automatically each time you open it.</p>
        <button onClick={() => void openAppSettings()}>Open app permissions</button>
      </section>
    );
  }
  return (
    <section>
      <h3>Android app</h3>
      <p className="muted">Install the app on your phone so GPS keeps recording with the screen off or while using other apps — essential for a gap-free record log.
        It loads this same app, so every update reaches it automatically.</p>
      <a className="btnlink primary" href={APK_URL}>Download Android app (.apk)</a>
      <details>
        <summary className="muted">How to install</summary>
        <ol className="muted small">
          <li>Open this page on your Android phone and tap <b>Download</b>.</li>
          <li>Open the downloaded <b>RideGrid-India.apk</b>. If asked, allow <b>“Install unknown apps”</b> for your browser/Files app.</li>
          <li>Open RideGrid → when navigation starts, allow <b>Location: Precise, While using the app</b> and <b>Notifications</b>.</li>
          <li>Settings → Apps → RideGrid → Battery → <b>Unrestricted</b> (stops Android from killing GPS on long rides).</li>
          <li>Your trips in Chrome don't move automatically: Files → Download backup in Chrome, then Restore in the app.</li>
        </ol>
      </details>
    </section>
  );
}

function GoogleStatus() {
  const st = mapCtl?.googleStatus;
  if (!st) return <p className="muted">Google map not showing (offline or key problem — use Test key).</p>;
  const r = st.rendering;
  return (
    <p className={r === 'VECTOR' && st.maxTilt > 0 ? 'muted' : 'warn'}>
      Google map: <b>{r === 'VECTOR' ? 'Vector' : r === 'RASTER' ? 'Basic (raster)' : 'loading…'}</b>
      {r === 'VECTOR' && (st.maxTilt > 0 ? ` · 3D tilt works (up to ${Math.round(st.maxTilt)}° so far)` : ' · tilt not confirmed yet — tap 3D at street level; if it stays flat, add your own Map ID below')}
      {r === 'RASTER' && ' · no 3D on this device/Map ID — add your own Vector Map ID below'}
    </p>
  );
}

function StateTracker() {
  useEngine();
  const [rows, setRows] = useState<StateKm[] | null>(null);
  const [missing, setMissing] = useState(false);
  const run = () => act('Working out km per state…', async () => {
    const r = await stateBreakdown(buildRouteLine(), engine.trip!.id);
    if (!r) { setMissing(true); return; }
    setMissing(false); setRows(r);
  });
  const tot = rows?.reduce((a, r) => ({ p: a.p + r.plannedKm, c: a.c + r.coveredKm }), { p: 0, c: 0 });
  return (
    <section>
      <h3>State-by-state</h3>
      <p className="muted">Planned km (road geometry) and covered km (real GPS rides) in every state & UT.</p>
      <button onClick={run} disabled={!engine.stops.length}>{rows ? 'Recalculate' : 'Show km per state'}</button>
      {missing && <p className="warn">State boundaries aren't downloaded yet — they arrive with the next app update.</p>}
      {rows && <table className="logtable statetable">
        <thead><tr><th>State / UT</th><th>Planned</th><th>Covered</th><th>Left</th></tr></thead>
        <tbody>
          {rows.map((r) => <tr key={r.name}><td>{r.name}{ILP_STATES.includes(r.name) ? ' 🛂' : ''}</td><td>{r.plannedKm.toFixed(0)}</td><td>{r.coveredKm.toFixed(0)}</td><td>{Math.max(0, r.plannedKm - r.coveredKm).toFixed(0)}</td></tr>)}
          <tr><td><b>Total</b></td><td><b>{tot!.p.toFixed(0)}</b></td><td><b>{tot!.c.toFixed(0)}</b></td><td><b>{Math.max(0, tot!.p - tot!.c).toFixed(0)}</b></td></tr>
        </tbody>
      </table>}
      {rows?.some((r) => ILP_STATES.includes(r.name)) && <p className="muted">🛂 = Inner Line Permit needed.</p>}
    </section>
  );
}
