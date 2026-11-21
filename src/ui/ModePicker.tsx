import { mode, MODE_LABEL, type AppMode } from '../core/mode';
import { engine } from '../core/engine';
import { switchMode } from '../core/trips';
import { ui, useUI, act } from './state';
import { mapCtl } from './App';
import { nav } from '../nav/navigator';
import { applyBase } from '../map/googleBase';
import { access } from '../daily/access';

const INFO: Record<AppMode, { icon: string; lines: string[] }> = {
  expedition: { icon: '🏁', lines: ['Fixed record route of waypoints', 'Guinness / Limca evidence logbook', 'No repeated roads, 20–30 m gap, no expressways'] },
  daily: { icon: '🏍', lines: ['Everyday rides with real stops', 'Live traffic & faster routes, expressways allowed', 'Offline maps, places, ride stats (growing)'] },
};

/** Full mode change: each mode has its own trips, screens and settings. */
export function ModePicker() {
  const open = useUI((s) => s.modePicker);
  if (!open) return null;
  const pick = (m: AppMode) => act(`Opening ${MODE_LABEL[m]}…`, async () => {
    if (nav.mode !== 'off' && m !== mode.current) throw new Error('Stop the current ride first');
    const changed = m !== mode.current || !mode.chosen;
    await switchMode(m);
    document.documentElement.dataset.mode = m;
    access.apply();
    if (mapCtl) await applyBase(mapCtl, true);
    ui.set({ modePicker: false, drawer: false, tab: 'trip', selectedId: null, place: null, places: [] });
    if (changed && engine.stops.length) setTimeout(() => mapCtl?.fitRoute(), 300);
  });
  return (
    <div className="modal-wrap" onClick={() => mode.chosen && ui.set({ modePicker: false })}>
      <div className="modal glass modepick" onClick={(e) => e.stopPropagation()}>
        <h3>{mode.chosen ? 'Switch mode' : 'Welcome — choose a mode'}</h3>
        <p className="muted">The two modes are kept completely separate: their own trips, screens and settings. You can switch any time from the menu.</p>
        {(['expedition', 'daily'] as AppMode[]).map((m) => (
          <button key={m} className={`modecard ${m} ${mode.chosen && mode.current === m ? 'on' : ''}`} onClick={() => pick(m)}>
            <span className="mi">{INFO[m].icon}</span>
            <span><b>{MODE_LABEL[m]}</b>{mode.chosen && mode.current === m && <span className="pill">current</span>}
              {INFO[m].lines.map((l) => <span key={l} className="muted">{l}</span>)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
