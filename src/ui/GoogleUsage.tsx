import { useEffect, useState } from 'react';
import { gquota } from '../core/gquota';

/** Google usage this month vs. the hard caps (per device; the free allowance is shared by your 3 devices). */
export function GoogleUsage() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((x) => x + 1); gquota.listeners.add(f); return () => { gquota.listeners.delete(f); }; }, []);
  const rows = gquota.all();
  return (
    <section>
      <h3>Google usage this month</h3>
      <p className="muted">This device's use of each Google feature against its cap. When a cap is reached the app quietly uses its own free version. Caps default to a third of Google's India free amount (you have 3 devices).</p>
      <table className="usage">
        <thead><tr><th>Feature</th><th>Used</th><th>Cap</th><th /></tr></thead>
        <tbody>{rows.map((r) => {
          const pct = r.cap ? Math.min(100, (r.used / r.cap) * 100) : 100;
          return (
            <tr key={r.sku}>
              <td>{r.label}<div className="muted">{r.level} · {r.free.toLocaleString('en-IN')} free / month (India)</div></td>
              <td>{r.used.toLocaleString('en-IN')}</td>
              <td><input type="number" min={0} value={r.cap} onChange={(e) => gquota.setCap(r.sku, +e.target.value)} /></td>
              <td><div className="ubar"><i style={{ width: `${pct}%`, background: pct > 90 ? '#e03131' : pct > 60 ? '#f59f00' : '#2f9e44' }} /></div></td>
            </tr>);
        })}</tbody>
      </table>
    </section>
  );
}
