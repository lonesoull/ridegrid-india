import { useEffect, useRef, useState } from 'react';
import { MapController } from '../map/MapController';
import { engine } from '../core/engine';
import { app } from '../core/app';
import { bootTrips, leaveStressTrip, deleteStressTrip } from '../core/trips';
import { fmtKm } from '../core/geo';
import { ui, useUI, toast, act, type TapMode } from './state';
import { useEngine, useRouterStatus } from './hooks';
import { Drawer } from './Drawer';
import { FpsMeter } from './FpsMeter';
import { StressRouteButton } from './StressRouteButton';
import { NavPanel } from './NavPanel';
import { nav } from '../nav/navigator';
import { useNav } from './navHooks';

export let mapCtl: MapController | null = null;

const TAP_NEXT: Record<TapMode, TapMode> = { append: 'insert', insert: 'off', off: 'append' };
const TAP_LABEL: Record<TapMode, string> = { append: 'Tap: add stop at end', insert: 'Tap: insert on route line', off: 'Tap: view only' };
const TAP_ICON: Record<TapMode, string> = { append: '＋', insert: '⤵', off: '✋' };

export function App() {
  const el = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    mapCtl = new MapController(el.current!);
    (async () => {
      await app.loadSettings();
      await nav.loadSettings();
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
    mapCtl?.setNight(night);
  }, [night]);

  return (
    <div className="app">
      <div ref={el} className="map" />
      {ready && <Hud />}
      {ready && <Controls />}
      {ready && <StopSheet />}
      {ready && <NavPanel />}
      {ready && <Drawer />}
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
    <div className="hud glass" onClick={() => ui.set({ drawer: true, tab: 'trip' })}>
      <div className="hud-title">{t?.name}{t?.sequenceLock ? <span className="lock" title="Sequence Lock on">🔒</span> : null}</div>
      <div className="hud-stats">
        <span><b>{engine.stops.length.toLocaleString('en-IN')}</b> stops</span>
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
      <button className="fab menu glass" aria-label="Open menu" onClick={() => ui.set({ drawer: true })}>☰</button>
      <div className="fabs">
        <button className="fab glass" title="Undo (Ctrl+Z)" disabled={!engine.canUndo} onClick={() => act(null, () => engine.undo())}>↶</button>
        <button className="fab glass" title="Redo (Ctrl+Y)" disabled={!engine.canRedo} onClick={() => act(null, () => engine.redo())}>↷</button>
        <button className={`fab glass tap-${tapMode}`} title={TAP_LABEL[tapMode]} onClick={() => { const n = TAP_NEXT[tapMode]; ui.set({ tapMode: n }); toast(TAP_LABEL[n]); }}>{TAP_ICON[tapMode]}</button>
        <button className="fab glass" title="Fit route" onClick={() => mapCtl?.fitRoute()}>⤢</button>
        <button className="fab glass" title="Tilt 3D / flat" onClick={() => mapCtl?.tilt()}>⛰</button>
        <button className="fab glass" title="North up, flat" onClick={() => mapCtl?.snapView()}>🧭</button>
        <button className="fab glass" title="My location" onClick={locate}>◎</button>
        <button className="fab glass" title="Day / Night" onClick={() => ui.set({ night: !night })}>{night ? '☀' : '☾'}</button>
      </div>
    </>
  );
}

function StopSheet() {
  useEngine(); useNav();
  const id = useUI((s) => s.selectedId);
  const [name, setName] = useState('');
  const i = id ? engine.indexOf(id) : -1;
  const s = engine.stops[i];
  useEffect(() => setName(s?.name ?? ''), [id, s?.name]);
  if (!s || nav.mode !== 'off') return null;
  return (
    <div className="sheet glass">
      <div className="sheet-head">
        <b>Stop #{(i + 1).toLocaleString('en-IN')}</b>
        <span className="muted">{s.lat.toFixed(6)}, {s.lng.toFixed(6)}</span>
        <button className="x" onClick={() => ui.set({ selectedId: null })}>✕</button>
      </div>
      <div className="row">
        <input value={name} placeholder="Name (optional)" onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== (s.name ?? '') && act(null, () => engine.renameStop(s.id, name))} />
      </div>
      <div className="row btns">
        <button onClick={() => mapCtl?.flyToStop(i - 1)} disabled={i === 0}>◀ Prev</button>
        <button onClick={() => mapCtl?.flyToStop(i + 1)} disabled={i === engine.stops.length - 1}>Next ▶</button>
        <button className="danger" onClick={() => { ui.set({ selectedId: null }); void act(null, () => engine.deleteStop(s.id)); }}>Delete</button>
      </div>
      <div className="hint">Drag the highlighted stop to move it. Only the two legs next to it are recalculated.</div>
    </div>
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
