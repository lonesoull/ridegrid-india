import { useEffect, useState } from 'react';
import { widgets, WIDGET_LABEL, type WidgetId } from './widgets';
import { quick, QA_LABEL, type QA } from './QuickActions';

/** "Configure screen": which widgets show where, and which quick-action buttons (in order). */
export function ScreenConfig() {
  const [, tick] = useState(0);
  useEffect(() => { void quick.load().then(() => tick((x) => x + 1)); }, []);
  const w = widgets.s;
  const setW = (left: WidgetId[], right: WidgetId[]) => void widgets.save({ left, right }).then(() => tick((x) => x + 1));
  const all = Object.keys(WIDGET_LABEL) as WidgetId[];
  const where = (id: WidgetId) => (w.left.includes(id) ? 'left' : w.right.includes(id) ? 'right' : 'off');
  const place = (id: WidgetId, to: 'left' | 'right' | 'off') => {
    const L = w.left.filter((x) => x !== id), R = w.right.filter((x) => x !== id);
    if (to === 'left') L.push(id); if (to === 'right') R.push(id);
    setW(L, R);
  };
  const move = (side: 'left' | 'right', i: number, d: -1 | 1) => {
    const arr = [...w[side]]; const j = i + d; if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    setW(side === 'left' ? arr : w.left, side === 'right' ? arr : w.right);
  };
  const qa = quick.list;
  const setQ = (l: QA[]) => void quick.save(l).then(() => tick((x) => x + 1));
  return (
    <section>
      <h3>Configure screen</h3>
      <details open>
        <summary><b>Widgets</b> <span className="muted">(shown on the map; ride values appear while navigating or recording)</span></summary>
        {(['left', 'right'] as const).map((side) => (
          <div key={side}><div className="muted">{side === 'left' ? 'Left column' : 'Right column'}</div>
            {w[side].map((id, i) => (
              <div key={id} className="item"><span>{WIDGET_LABEL[id]}</span>
                <div className="btns sm"><button onClick={() => move(side, i, -1)}>↑</button><button onClick={() => move(side, i, 1)}>↓</button><button onClick={() => place(id, 'off')}>✕</button></div></div>
            ))}
          </div>
        ))}
        <label className="field">Add a widget
          <select value="" onChange={(e) => { const [id, side] = e.target.value.split(':') as [WidgetId, 'left' | 'right']; if (id) place(id, side); }}>
            <option value="">Choose…</option>
            {all.filter((id) => where(id) === 'off').flatMap((id) => [<option key={id + 'l'} value={`${id}:left`}>{WIDGET_LABEL[id]} → left</option>, <option key={id + 'r'} value={`${id}:right`}>{WIDGET_LABEL[id]} → right</option>])}
          </select>
        </label>
      </details>
      <details>
        <summary><b>Quick-action buttons</b></summary>
        {qa.map((a, i) => (
          <div key={a} className="item"><span>{QA_LABEL[a]}</span>
            <div className="btns sm">
              <button onClick={() => { if (i) { const l = [...qa]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; setQ(l); } }}>↑</button>
              <button onClick={() => setQ(qa.filter((x) => x !== a))}>✕</button></div></div>
        ))}
        <label className="field">Add a button
          <select value="" onChange={(e) => e.target.value && setQ([...qa, e.target.value as QA])}>
            <option value="">Choose…</option>
            {(Object.keys(QA_LABEL) as QA[]).filter((a) => !qa.includes(a)).map((a) => <option key={a} value={a}>{QA_LABEL[a]}</option>)}
          </select>
        </label>
      </details>
    </section>
  );
}
