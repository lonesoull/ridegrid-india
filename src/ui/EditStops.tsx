import { useRef, useState } from 'react';
import { engine, type Stop } from '../core/engine';
import { fmtKm } from '../core/geo';
import { T } from '../core/terms';
import { mapCtl } from './App';
import { ui, useUI, act, toast } from './state';
import { useEngine } from './hooks';
import { Icon } from './Icon';

const ROW = 56;
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

/**
 * "Edit stops", like Google Maps: drag the handle to reorder, ✕ to remove, + to add (via search).
 * Each change is one undo step.
 */
export function EditStops() {
  useEngine();
  const open = useUI((s) => s.editStops);
  const [order, setOrder] = useState<Stop[] | null>(null);
  const [dragI, setDragI] = useState<number | null>(null);
  const drag = useRef<{ from: number; y0: number; pid: number } | null>(null);
  if (!open) return null;
  const list = order ?? engine.stops;
  const many = list.length > 60;
  const close = () => { ui.set({ editStops: false }); setOrder(null); };

  const onDown = (i: number) => (e: React.PointerEvent) => {
    if (engine.trip?.sequenceLock) { toast('Sequence Lock is on — unlock it to reorder.'); return; }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { from: i, y0: e.clientY, pid: e.pointerId };
    setOrder(engine.stops.slice()); setDragI(i);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || !order) return;
    const to = Math.max(0, Math.min(order.length - 1, d.from + Math.round((e.clientY - d.y0) / ROW)));
    if (to === dragI) return;
    const next = order.slice(); const [s] = next.splice(dragI!, 1); next.splice(to, 0, s);
    setOrder(next); setDragI(to);
  };
  const onUp = () => {
    const d = drag.current; drag.current = null;
    const changed = order && d && dragI !== d.from;
    setDragI(null);
    if (changed) void act(null, () => engine.replaceAll(order!)).then(() => setOrder(null));
    else setOrder(null);
  };

  return (
    <>
      <div className="search-scrim" onClick={close} />
      <div className="bottomsheet editstops" role="dialog" aria-label="Edit stops">
        <div className="bs-handle" />
        <div className="bs-head"><span>Edit {T().many}</span><button className="textbtn" onClick={close}>Done</button></div>
        <div className="es-list" onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {(many ? list.slice(0, 60) : list).map((s, i) => (
            <div key={s.id} className={`es-row ${dragI === i ? 'dragging' : ''}`}>
              <span className="es-badge">{letter(i)}</span>
              <button className="es-name" onClick={() => { close(); mapCtl?.flyToStop(i); }}>
                <span className="restitle">{s.name || (i === 0 ? 'Start' : i === list.length - 1 ? 'Destination' : `${T().One} ${i + 1}`)}</span>
                <span className="ressub">{s.lat.toFixed(5)}, {s.lng.toFixed(5)}</span>
              </button>
              <button className="iconbtn" aria-label={`Remove ${s.name ?? letter(i)}`} onClick={() => act(null, () => engine.deleteStop(s.id))}><Icon name="close" size={20} /></button>
              <span className="es-grip" aria-label="Drag to reorder" onPointerDown={onDown(i)}><Icon name="list" size={20} /></span>
            </div>
          ))}
          {many && <p className="bs-note">Showing the first 60 of {list.length.toLocaleString('en-IN')}. Use Settings → {T().Many} for long lists.</p>}
          {!list.length && <p className="bs-note">No {T().many} yet. Search for a place or long-press the map, then tap “Add stop”.</p>}
        </div>
        <div className="es-foot">
          <button onClick={() => { close(); (document.querySelector('.searchpill input') as HTMLInputElement | null)?.focus(); }}><Icon name="plus" size={18} /> Add {T().one}</button>
          {list.length > 1 && <button onClick={() => act(null, () => engine.reverse())}><Icon name="swap" size={18} /> Reverse</button>}
          {engine.routedM > 0 && <span className="muted">{fmtKm(engine.routedM)} by road</span>}
        </div>
      </div>
    </>
  );
}
