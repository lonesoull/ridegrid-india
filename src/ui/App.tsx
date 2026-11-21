import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { EditStops } from './EditStops';
import { locateMe } from './locate';
import { SearchTop } from './Search';
import { startLocate } from './locate';
import { T } from '../core/terms';
import { MapController } from '../map/MapController';
import { engine } from '../core/engine';
import { app } from '../core/app';
import { bootTrips, leaveStressTrip, deleteStressTrip } from '../core/trips';
import { fmtKm } from '../core/geo';
import { ui, useUI, toast, act, type TapMode } from './state';
import { useEngine, useRouterStatus } from './hooks';
// settings pages load on first open (keeps the app's start small)
const Drawer = lazy(() => import('./Drawer').then((m) => ({ default: m.Drawer })));
import { FpsMeter } from './FpsMeter';
import { StopSheet } from './StopSheet';
import { MirrorPanel } from './MirrorPanel';
import { SosModal, RouteOfferModal } from './TeamModals';
import { team } from '../team/team';
import { startTelemetry } from '../team/telemetry';
import { startTeamEvents } from '../team/actions';
import { startCompliance, compliance, fmtHms } from '../nav/compliance';
import { loadExpressways } from '../nav/expressways';
import { riddenLines } from '../nav/history';
import { device } from '../route/device';
import { reminder } from '../nav/evidence';
import { PlaceCard } from './PlaceCard';
import { Icon } from './Icon';
import { useNav } from './navHooks';
import { google } from '../core/google';
import { applyBase } from '../map/googleBase';
import { LogStopDialog } from './LogStopDialog';
import { StressRouteButton } from './StressRouteButton';
import { NavPanel } from './NavPanel';
import { nav } from '../nav/navigator';
import { startHandoffWatch } from '../nav/handoff';
import { ModePicker } from './ModePicker';
import { dailyMap } from '../daily/mapLayers';
import { dailyNav } from '../daily/dailyNav';
import { widgets } from '../daily/widgets';
import { markers } from '../daily/markers';
import { recorder } from '../daily/recorder';
import { bikes } from '../daily/profiles';
import { access } from '../daily/access';
import { DailyLayer } from '../daily/DailyLayer';
import { WatchView } from '../daily/WatchView';
import { offlineMaps } from '../daily/offlineMap';
import { offlineSearch } from '../daily/offlineSearch';
import { offlineTerrain } from '../daily/offlineTerrain';
import { startDailyOverlays } from '../daily/overlays';
import { startDaily } from '../daily/startDaily';
import { startMapExtras } from '../daily/mapExtras';
import { startWeatherLayers } from '../daily/weatherLayers';
import { handleLaunch, listenAppLinks } from '../daily/launch';
import { mode } from '../core/mode';

export let mapCtl: MapController | null = null;

const TAP_NEXT: Record<TapMode, TapMode> = { append: 'insert', insert: 'off', off: 'append' };
const TAP_LABEL = (m: TapMode) => ({ append: `Tap: add ${T().one} at end`, insert: 'Tap: insert on route line', off: 'Tap: view only' }[m]);
const TAP_ICON: Record<TapMode, string> = { append: 'plus', insert: 'insert', off: 'hand' };

/** night setting the current map style was built with */
let baseNight: boolean | null = null;

export function App() {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    mapCtl = new MapController(el.current!);
    (async () => {
      await app.loadSettings();
      await nav.loadSettings();
      await google.load();
      await dailyMap.load();
      await dailyNav.load();
      await Promise.all([widgets.load(), markers.load(), recorder.load(), bikes.load()]);
      void offlineMaps.boot();
      // heavy on-device data loads after the map is showing, when the phone is idle
      const later = (f: () => void, ms: number) => setTimeout(() => ((window as any).requestIdleCallback ?? ((g: () => void) => g()))(f), ms);
      later(() => void offlineSearch.boot(), 2500);
      void offlineTerrain.boot();
      startDailyOverlays(mapCtl!);
      startDaily(mapCtl!);
      startLocate(mapCtl!);
      startMapExtras(mapCtl!);
      startWeatherLayers(mapCtl!);
      google.listeners.add(() => ui.set({ gtick: ui.get().gtick + 1 }));
      startTelemetry(); startTeamEvents(); startCompliance(); startHandoffWatch();
      later(() => void device.boot().then(() => app.queue.kick()), 1500);
      // two-wheeler-banned roads on the map: expedition trips only
      let bannedFor: string | null = null;
      const showBanned = () => {
        const k = `${engine.trip?.id}:${engine.trip?.kind}`;
        if (k === bannedFor) return;
        bannedFor = k;
        // only Expedition shows two-wheeler-banned roads; Daily never downloads or draws them (several MB)
        if (engine.trip?.kind !== 'expedition') { mapCtl?.setBanned(null); return; }
        void loadExpressways().then((d) => { if (engine.trip?.kind === 'expedition') mapCtl?.setBanned(d ? d.fc : null); });
      };
      showBanned();
      engine.subscribe(() => showBanned());
      const drawRidden = () => engine.trip && riddenLines(engine.trip.id).then((l) => mapCtl?.setRidden(l));
      void drawRidden();
      engine.subscribe((e) => { if (e.stops && e.legs === undefined) void drawRidden(); });
      let navWas = nav.mode;
      nav.subscribe(() => { if (nav.mode !== navWas) { navWas = nav.mode; if (nav.mode === 'off') void drawRidden(); } });
      void team.load();
      if (location.hash.startsWith('#join=')) ui.set({ drawer: true, tab: 'team' });
      // know the mode first, then build the map style once (it used to be built three times at start)
      await bootTrips();
      document.documentElement.dataset.mode = mode.current;
      await applyBase(mapCtl!);
      baseNight = ui.get().night;
      window.addEventListener('online', () => mapCtl && applyBase(mapCtl));
      window.addEventListener('offline', () => mapCtl && applyBase(mapCtl));
      void access.load();
      if (!mode.chosen) ui.set({ modePicker: true });
      void reminder.start();
      void handleLaunch().catch((e) => toast(String(e?.message ?? e), 'error'));
      void listenAppLinks();
      setReady(true);
      if (engine.stops.length) setTimeout(() => mapCtl?.fitRoute(), 400);
    })().catch((e) => toast(String(e), 'error'));
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return;
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); void act(null, () => (e.shiftKey ? engine.redo() : engine.undo())); }
      else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); void act(null, () => engine.redo()); }
      else if ((k === 'delete' || k === 'backspace') && ui.get().selectedId) { void act(null, () => engine.deleteStop(ui.get().selectedId!)); ui.set({ selectedId: null }); }
      else if (k === 'escape') ui.set({ selectedId: null, drawer: false });
    };
    window.addEventListener('keydown', onKey);
    const flush = () => { void engine.flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('pagehide', flush); };
  }, []);

  const night = useUI((s) => s.night);
  useEffect(() => {
    document.documentElement.dataset.theme = night ? 'dark' : 'light';
    if (ready && mapCtl && night !== baseNight) { baseNight = night; void applyBase(mapCtl); }
  }, [night, ready]);

  // live-location viewer link (#watch=CODE): only the map and the rider
  const watch = /^#watch=([A-Z0-9]{25})$/.exec(location.hash)?.[1];
  if (watch) return (<div className="app"><div ref={el} className="map" />{mapCtl && <WatchView code={watch} />}<WatchBoot /></div>);
  return (
    <div className="app">
      <div ref={el} className="map" />
      {ready && <HudGate />}
      {ready && <Controls />}
      {ready && <StopSheet />}
      {ready && <PlaceCard />}
      {ready && <EditStops />}
      {ready && <MirrorPanel />}
      {ready && <SosModal />}
      {ready && <RouteOfferModal />}
      {ready && <NavPanel />}
      {ready && <DrawerGate />}
      {ready && <LogStopDialog />}
      {ready && <ModePicker />}
      {ready && <DailyLayer />}
      <Toast />
      <FpsMeterGate />
    </div>
  );
}

function Hud() {
  useEngine();
  const status = useRouterStatus();
  const t = engine.trip;
  const daily = t?.kind === 'daily';
  const target = t?.targetKm ? t.targetKm * 1000 : 0;
  const covered = t?.coveredM ?? 0;
  const pending = engine.pendingLegs, errors = engine.errorLegs;
  const routing = (pending > 0 || errors > 0 || status === 'offline' || status === 'backoff' || status === 'paused') && !(t?.isStress && status === 'paused');
  return (
    <div className="hud">
      <SearchTop onSettings={() => ui.set({ drawer: true, tab: 'home' })} />
      <div className="statusrow">
        {!daily && t && (
          <button className="statuschip" onClick={() => ui.set({ drawer: true, tab: 'trip' })}>
            <b>{t.name}</b>{t.sequenceLock ? ' 🔒' : ''} · {engine.stops.length.toLocaleString('en-IN')} {T().n(engine.stops.length)} · {fmtKm(engine.routedM)} mapped · {fmtKm(covered)} covered{target > 0 ? ` · ${fmtKm(Math.max(0, target - covered))} left` : ''}
          </button>
        )}
        {daily && engine.stops.length > 0 && (
          <button className="statuschip" onClick={() => ui.set({ editStops: true })}><Icon name="route" size={16} /> <b>{engine.stops.length} {T().n(engine.stops.length)}</b>{engine.routedM > 0 ? ` · ${fmtKm(engine.routedM)}` : ''} · Edit</button>
        )}
        {routing && (
          <span className={`statuschip st-${status}`}>
            {status === 'offline' ? 'Offline — ' : status === 'backoff' ? 'Server busy, retrying — ' : status === 'paused' ? 'Auto-route paused — ' : <><span className="spin" /> {daily ? 'Planning route — ' : 'Snapping to roads — '}</>}
            {pending.toLocaleString('en-IN')} {daily ? 'parts' : 'legs'} left{errors ? ` · ${errors} failed` : ''}
          </span>
        )}
        <HaltChip />
      </div>
      {t?.isStress && (
        <div className="hud-stress glass" onClick={(e) => e.stopPropagation()}>
          <span>Viewing STRESS TEST trip (test stops only). Your real stops are in your own trip.</span>
          <StressRouteButton />
          <button className="sm" onClick={() => act(null, () => leaveStressTrip()).then(() => setTimeout(() => mapCtl?.fitRoute(), 300))}>Back to my trip</button>
          <button className="sm danger" onClick={() => confirm('Clear ALL stress-test stops and delete the Stress Test trip?') && act('Clearing stress test…', () => deleteStressTrip())}>Clear all</button>
        </div>
      )}
    </div>
  );
}

function HaltChip() {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 1000); const off = compliance.subscribe(() => tick((x) => x + 1)); return () => { clearInterval(i); off(); }; }, []);
  const left = compliance.haltLeftS;
  if (left === null || engine.trip?.kind === 'daily') return null;
  const h = left / 3600;
  return <div className={`haltchip ${h <= 1 ? 'danger' : h <= 12 ? 'warn' : ''}`}>{left > 0 ? `Halt timer ${fmtHms(left)} left of ${compliance.settings.haltHours} h` : `Maximum ${compliance.settings.haltHours} h halt exceeded`}</div>;
}

function HudGate() {
  useNav();
  return nav.mode === 'off' ? <Hud /> : null;
}

/**
 * Map buttons, Google Maps style: Layers at the top right; my location and Ride at the bottom right;
 * everything else (undo, redo, fit, tilt, night…) folds away under a chevron. A compass appears only when the map is turned.
 */
function Controls() {
  useEngine();
  const tapMode = useUI((s) => s.tapMode);
  const locMode = useUI((s) => s.locMode);
  const daily = mode.current === 'daily';
  const place = useUI((s) => s.place);
  useNav();
  const [more, setMore] = useState(false);
  const [layers, setLayers] = useState(false);
  const [turned, setTurned] = useState(false);
  useEffect(() => {
    const m = mapCtl?.map; if (!m) return;
    const f = () => { const t = Math.abs(m.getBearing()) > 1 || m.getPitch() > 1; setTurned((x) => (x === t ? x : t)); };
    m.on('rotate', f); m.on('pitch', f); f();
    return () => { m.off('rotate', f); m.off('pitch', f); };
  }, []);
  const tap = () => { const n = TAP_NEXT[tapMode]; ui.set({ tapMode: n }); toast(TAP_LABEL(n)); };
  return (
    <>
      <div className="fabs-top">
        <button className="fab" aria-label="Map layers" onClick={() => setLayers(true)}><Icon name="layers" /></button>
        {turned && <button className="fab" aria-label="North up" onClick={() => { mapCtl?.snapView(); ui.set({ locMode: locMode === 'compass' ? 'follow' : locMode }); }}><Icon name="compass" /></button>}
      </div>
      {!place && nav.mode === 'off' && <div className="fabs-bottom">
        {more && (
          <div className="fab-more">
            {daily && <button className={`fab tap-${tapMode}`} aria-label={TAP_LABEL(tapMode)} onClick={tap}><Icon name={TAP_ICON[tapMode]} /></button>}
            {daily && <button className="fab" aria-label="Undo" disabled={!engine.canUndo} onClick={() => act(null, () => engine.undo())}><Icon name="undo" /></button>}
            <button className="fab" aria-label="Redo" disabled={!engine.canRedo} onClick={() => act(null, () => engine.redo())}><Icon name="redo" /></button>
            <button className="fab" aria-label="Show whole route" onClick={() => { mapCtl?.fitRoute(); setMore(false); }}><Icon name="fit" /></button>
            <button className="fab" aria-label="3D tilt" onClick={() => mapCtl?.tilt()}><Icon name="tilt" /></button>
          </div>
        )}
        <button className="fab small" aria-label={more ? 'Fewer buttons' : 'More buttons'} aria-expanded={more} onClick={() => setMore(!more)}><Icon name={more ? 'chevdown' : 'chevup'} size={20} /></button>
        {!daily && <button className={`fab tap-${tapMode}`} aria-label={TAP_LABEL(tapMode)} onClick={tap}><Icon name={TAP_ICON[tapMode]} /></button>}
        {!daily && <button className="fab" aria-label="Undo" disabled={!engine.canUndo} onClick={() => act(null, () => engine.undo())}><Icon name="undo" /></button>}
        <button className={`fab loc-${locMode}`} aria-label="My location" onClick={() => void locateMe()}><Icon name={locMode === 'compass' ? 'compass' : 'locate'} /></button>
        <button className="fab go" aria-label="Ride" onClick={() => ui.set({ drawer: true, tab: 'ride' })}><Icon name="directions" size={26} /></button>
      </div>}
      {layers && <LayersSheet onClose={() => setLayers(false)} />}
    </>
  );
}

/** Map layers, like Google Maps' layers sheet: map type and the Google layers, plus night. */
function LayersSheet({ onClose }: { onClose: () => void }) {
  useUI((s) => s.gtick);
  const night = useUI((s) => s.night);
  const [, tick] = useState(0);
  const g = google.settings;
  const daily = mode.current === 'daily';
  const d = dailyMap.settings;
  const gOn = !!g.key && g.on;
  const setD = (p: Partial<typeof d>) => act(null, async () => { await dailyMap.save(p); if (mapCtl) await applyBase(mapCtl, true); tick((x) => x + 1); });
  const types = [['roadmap', 'Default', 'map'], ['satellite', 'Satellite', 'eye'], ['hybrid', 'Hybrid', 'layers'], ['terrain', 'Terrain', 'activity']] as const;
  return (
    <>
      <div className="search-scrim" onClick={onClose} />
      <div className="bottomsheet" role="dialog" aria-label="Map layers">
        <div className="bs-handle" />
        <div className="bs-head"><span>{daily && gOn ? 'Map type' : 'Map layers'}</span><button className="iconbtn" aria-label="Close" onClick={onClose}><Icon name="close" size={20} /></button></div>
        {daily && gOn && (
          <div className="tiles">
            {types.map(([k, l, ic]) => <button key={k} className={`tile ${d.gType === k ? 'on' : ''}`} onClick={() => setD({ gType: k })}><span className="tile-ico"><Icon name={ic} /></span>{l}</button>)}
          </div>
        )}
        <div className="bs-head"><span>Map details</span></div>
        <div className="tiles">
          {gOn && <button className={`tile ${g.traffic ? 'on' : ''}`} onClick={() => act(null, async () => { await google.save({ traffic: !g.traffic }); if (mapCtl) await applyBase(mapCtl, true); tick((x) => x + 1); })}><span className="tile-ico"><Icon name="traffic" /></span>Traffic</button>}
          {daily && gOn && <button className={`tile ${d.gTransit ? 'on' : ''}`} onClick={() => setD({ gTransit: !d.gTransit })}><span className="tile-ico"><Icon name="route" /></span>Transit</button>}
          {daily && <button className={`tile ${d.trails ? 'on' : ''}`} onClick={() => setD({ trails: !d.trails })}><span className="tile-ico"><Icon name="flag" /></span>Trails</button>}
          <button className={`tile ${night ? 'on' : ''}`} onClick={() => ui.set({ night: !night })}><span className="tile-ico"><Icon name="moon" /></span>Night</button>
        </div>
        {!gOn && <p className="bs-note">Add your Google key in Settings → Google Maps for Google's map, satellite and live traffic.</p>}
        {daily && <button className="textbtn" onClick={() => { onClose(); ui.set({ drawer: true, tab: 'map' }); }}>More map options</button>}
      </div>
    </>
  );
}

function Toast() {
  const t = useUI((s) => s.toast);
  const busy = useUI((s) => s.busy);
  return (
    <>
      {busy && <div className="toast glass busy"><span className="spin" /> {busy}</div>}
      {t && !busy && <div className={`toast glass ${t.kind}`} onClick={() => ui.set({ toast: null })}>{t.msg}</div>}
    </>
  );
}

function FpsMeterGate() {
  const on = useUI((s) => s.fps);
  return on ? <FpsMeter /> : null;
}

/** Re-render once the map exists (viewer page). */
function WatchBoot() { const [, t] = useState(0); useEffect(() => { const i = setInterval(() => { if (mapCtl) { t(1); clearInterval(i); } }, 200); return () => clearInterval(i); }, []); return null; }

/** Settings load the first time they are opened, then stay loaded. */
function DrawerGate() {
  const open = useUI((s) => s.drawer);
  const [wanted, setWanted] = useState(false);
  useEffect(() => { if (open) setWanted(true); }, [open]);
  useEffect(() => { const t = setTimeout(() => setWanted(true), 6000); return () => clearTimeout(t); }, []); // preload when idle
  return wanted ? <Suspense fallback={open ? <div className="drawer open"><div className="sp-status"><span className="spin" /> Loading…</div></div> : null}><Drawer /></Suspense> : null;
}
