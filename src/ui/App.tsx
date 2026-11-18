import { useEffect, useRef, useState } from 'react';
import { T } from '../core/terms';
import { MapController } from '../map/MapController';
import { engine } from '../core/engine';
import { app } from '../core/app';
import { bootTrips, leaveStressTrip, deleteStressTrip } from '../core/trips';
import { fmtKm } from '../core/geo';
import { ui, useUI, toast, act, type TapMode } from './state';
import { useEngine, useRouterStatus } from './hooks';
import { Drawer } from './Drawer';
import { FpsMeter } from './FpsMeter';
import { StopSheet } from './StopSheet';
import { SearchBar } from './SearchBar';
import { PlaceCard } from './PlaceCard';
import { Icon } from './Icon';
import { useNav } from './navHooks';
import { google } from '../core/google';
import { applyBase } from '../map/googleBase';
import { GoogleAttribution } from './GoogleAttribution';
import { LogStopDialog } from './LogStopDialog';
import { StressRouteButton } from './StressRouteButton';
import { NavPanel } from './NavPanel';
import { nav } from '../nav/navigator';

export let mapCtl: MapController | null = null;

const TAP_NEXT: Record<TapMode, TapMode> = { append: 'insert', insert: 'off', off: 'append' };
const TAP_LABEL = (m: TapMode) => ({ append: `Tap: add ${T().one} at end`, insert: 'Tap: insert on route line', off: 'Tap: view only' }[m]);
const TAP_ICON: Record<TapMode, string> = { append: 'plus', insert: 'insert', off: 'hand' };

export function App() {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    mapCtl = new MapController(el.current!);
    (async () => {
      await app.loadSettings();
      await nav.loadSettings();
      await google.load();
      google.listeners.add(() => ui.set({ gtick: ui.get().gtick + 1 }));
      await applyBase(mapCtl!);
      window.addEventListener('online', () => mapCtl && applyBase(mapCtl));
      window.addEventListener('offline', () => mapCtl && applyBase(mapCtl));
      await bootTrips();
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
    if (ready && mapCtl) void applyBase(mapCtl);
  }, [night, ready]);

  return (
    <div className="app">
      <div ref={el} className="map" />
      {ready && <HudGate />}
      {ready && <Controls />}
      {ready && <StopSheet />}
      {ready && <PlaceCard />}
      {ready && <NavPanel />}
      {ready && <Drawer />}
      {ready && <GoogleAttribution />}
      {ready && <LogStopDialog />}
      <Toast />
      <FpsMeterGate />
    </div>
  );
}

function Hud() {
  useEngine();
  const status = useRouterStatus();
  const t = engine.trip;
  const target = t?.targetKm ? t.targetKm * 1000 : 0;
  const covered = t?.coveredM ?? 0;
  const pending = engine.pendingLegs, errors = engine.errorLegs;
  return (
    <div className="hud glass">
      <SearchBar />
      <div className="hud-title" onClick={() => ui.set({ drawer: true, tab: 'trip' })}><span className={`kind ${t?.kind === 'daily' ? 'daily' : 'exp'}`}>{t?.kind === 'daily' ? 'Daily' : 'Expedition'}</span>{t?.name}{t?.sequenceLock ? <span className="lock" title="Sequence Lock on">🔒</span> : null}</div>
      <div className="hud-stats" onClick={() => ui.set({ drawer: true, tab: 'trip' })}>
        <span><b>{engine.stops.length.toLocaleString('en-IN')}</b> {T().n(engine.stops.length)}</span>
        <span><b>{fmtKm(engine.routedM)}</b> mapped</span>
        <span><b>{fmtKm(covered)}</b> covered</span>
        {target > 0 && <span><b>{fmtKm(Math.max(0, target - covered))}</b> left</span>}
      </div>
      {t?.isStress && (
        <div className="hud-stress" onClick={(e) => e.stopPropagation()}>
          <span>⚙ Viewing STRESS TEST trip (test stops only). Your real stops are in your own trip.</span>
          <StressRouteButton />
          <button className="sm" onClick={() => act(null, () => leaveStressTrip()).then(() => setTimeout(() => mapCtl?.fitRoute(), 300))}>Back to my trip</button>
          <button className="sm danger" onClick={() => confirm('Clear ALL stress-test stops and delete the Stress Test trip?') && act('Clearing stress test…', () => deleteStressTrip())}>Clear all</button>
        </div>
      )}
      {(pending > 0 || errors > 0 || status === 'offline' || status === 'backoff' || status === 'paused') && !(t?.isStress && status === 'paused') && (
        <div className={`hud-router st-${status}`}>
          {status === 'offline' ? '📴 Offline — ' : status === 'backoff' ? '⏳ Server busy, retrying — ' : status === 'paused' ? '⏸ Auto-route paused — ' : '🛣 Snapping to roads — '}
          {pending.toLocaleString('en-IN')} legs pending{errors ? ` · ${errors} failed` : ''}
        </div>
      )}
    </div>
  );
}

function TrafficFab() {
  useUI((s) => s.gtick);
  const g = google.settings;
  if (!g.key || !g.on) return null;
  return (
    <button className={`fab glass ${g.traffic ? 'traffic-on' : ''}`} title={g.traffic ? 'Hide live traffic' : 'Show live traffic'}
      onClick={() => act(null, async () => { await google.save({ traffic: !g.traffic }); if (mapCtl) await applyBase(mapCtl, true); })}>
      <Icon name="traffic" />
    </button>
  );
}

function HudGate() {
  useNav();
  return nav.mode === 'off' ? <Hud /> : null;
}

function Controls() {
  useEngine();
  const tapMode = useUI((s) => s.tapMode);
  const night = useUI((s) => s.night);
  const locate = () => {
    if (!navigator.geolocation) { toast('GPS not available', 'error'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => mapCtl?.showMe([p.coords.longitude, p.coords.latitude]),
      (e) => toast(`GPS: ${e.message}`, 'error'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };
  return (
    <>
      <button className="fab menu glass" aria-label="Open menu" onClick={() => ui.set({ drawer: true })}><Icon name="menu" size={26} /></button>
      <div className="fabs">
        <button className="fab glass" title="Undo (Ctrl+Z)" disabled={!engine.canUndo} onClick={() => act(null, () => engine.undo())}><Icon name="undo" /></button>
        <button className="fab glass" title="Redo (Ctrl+Y)" disabled={!engine.canRedo} onClick={() => act(null, () => engine.redo())}><Icon name="redo" /></button>
        <button className={`fab glass tap-${tapMode}`} title={TAP_LABEL(tapMode)} onClick={() => { const n = TAP_NEXT[tapMode]; ui.set({ tapMode: n }); toast(TAP_LABEL(n)); }}><Icon name={TAP_ICON[tapMode]} /></button>
        <button className="fab glass go" title="Ride / simulate this route" onClick={() => ui.set({ drawer: true, tab: 'ride' })}><Icon name="bike" size={26} /></button>
        <TrafficFab />
        <button className="fab glass" title="Fit route" onClick={() => mapCtl?.fitRoute()}><Icon name="fit" /></button>
        <button className="fab glass" title="Tilt 3D / flat" onClick={() => mapCtl?.tilt()}><Icon name="tilt" /></button>
        <button className="fab glass" title="North up, flat" onClick={() => mapCtl?.snapView()}><Icon name="compass" /></button>
        <button className="fab glass" title="My location" onClick={locate}><Icon name="locate" /></button>
        <button className="fab glass" title="Day / Night" onClick={() => ui.set({ night: !night })}><Icon name={night ? 'sun' : 'moon'} /></button>
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
