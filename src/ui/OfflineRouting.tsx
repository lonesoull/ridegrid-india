import { useEffect, useState } from 'react';
import { device, ZONES } from '../route/device';
import { act, toast } from './state';

const mb = (b?: number) => (b ? `${(b / 1048576).toFixed(0)} MB` : '—');
const TIERS = [
  { id: (z: string) => `${z}-main`, label: 'Main roads', note: 'highways, main & village roads — no town lanes' },
  { id: (z: string) => z, label: 'All streets', note: 'adds every residential lane (larger)' },
];
type Meta = { bytes?: number; km?: number; generated?: string; gz?: number } | null;

/** Download India's road network per zone for instant, offline routing (no servers, no limits). */
export function OfflineRouting() {
  const [, tick] = useState(0);
  const [inst, setInst] = useState<Awaited<ReturnType<typeof device.installed>>>([]);
  const [meta, setMeta] = useState<Record<string, Meta>>({});
  const [prog, setProg] = useState<Record<string, string>>({});
  const reload = () => device.installed().then(setInst);
  useEffect(() => {
    void reload();
    const f = () => tick((x) => x + 1);
    device.listeners.add(f);
    // sizes published by the build (gz size from the server's headers)
    for (const z of ZONES) for (const t of TIERS) {
      const id = t.id(z.zone);
      void Promise.all([
        fetch(`${import.meta.env.BASE_URL}graphs/${id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(`${import.meta.env.BASE_URL}graphs/${id}.rgg.gz`, { method: 'HEAD' }).then((r) => (r.ok ? +(r.headers.get('content-length') ?? 0) : 0)).catch(() => 0),
      ]).then(([j, gz]) => setMeta((m) => ({ ...m, [id]: j && gz ? { ...j, gz } : null })));
    }
    return () => { device.listeners.delete(f); };
  }, []);
  return (
    <section>
      <h3>Offline routing (on-device)</h3>
      <p className="muted">Download a region's road network once (Wi-Fi recommended). Routes inside it are then calculated on this device — instant, no internet, no server limits — with two-wheeler-banned expressways, private and no-access roads left out of the road network itself. <b>Main roads</b> is enough for long rides; <b>All streets</b> also covers lanes inside towns.</p>
      {ZONES.map((z) => {
        const have = inst.find((i) => i.zone === z.zone || i.zone === `${z.zone}-main`);
        return (
          <div className="item" key={z.zone}>
            <div><b>{z.label}</b> {have && <span className="pill">{device.loaded.has(have.zone) ? 'ready' : 'stored'} · {have.zone.endsWith('-main') ? 'main roads' : 'all streets'}</span>}
              <div className="muted">{z.states}</div>
              {TIERS.map((t) => {
                const id = t.id(z.zone), m = meta[id];
                return <div className="muted" key={id}>{t.label}: {m ? `${mb(m.gz)} download · ${mb(m.bytes)} on device · ${Math.round((m.km ?? 0) / 1000).toLocaleString('en-IN')}k km` : m === null ? 'not available yet' : '…'}</div>;
              })}
              {have?.generated && <div className="muted">map data {new Date(have.generated).toLocaleDateString('en-IN')}</div>}
            </div>
            <div className="btns sm">
              {TIERS.map((t) => {
                const id = t.id(z.zone), m = meta[id], p = prog[id];
                if (p) return <span className="muted" key={id}>{p}</span>;
                if (have?.zone === id) return m?.generated && have.generated !== m.generated
                  ? <button key={id} className="primary" onClick={() => dl(id)}>Update</button> : null;
                return <button key={id} className={have ? '' : 'primary'} disabled={!m || Object.keys(prog).length > 0} title={t.note} onClick={() => dl(id)}>{have ? `Switch to ${t.label.toLowerCase()}` : t.label}</button>;
              })}
              {have && <button onClick={() => act(null, () => device.remove(have.zone)).then(reload)}>Remove</button>}
            </div>
          </div>
        );
      })}
      <p className="muted small-note">Road data © OpenStreetMap contributors (ODbL). Regions overlap at their borders; routes that cross between two downloaded regions use the internet servers for that leg (for now).</p>
    </section>
  );
  function dl(id: string) {
    setProg((x) => ({ ...x, [id]: 'starting…' }));
    void device.download(id, (d, t) => setProg((x) => ({ ...x, [id]: t ? `${Math.round((d / t) * 100)}% (${mb(d)} of ${mb(t)})` : mb(d) })))
      .then(() => { toast('Region ready — routes there now work offline'); })
      .catch((e) => toast(e.message, 'error'))
      .finally(() => { setProg((x) => { const y = { ...x }; delete y[id]; return y; }); void reload(); });
  }
}
