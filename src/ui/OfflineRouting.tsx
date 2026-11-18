import { useEffect, useState } from 'react';
import { device, ZONES } from '../route/device';
import { act, toast } from './state';

const mb = (b?: number) => (b ? `${(b / 1048576).toFixed(0)} MB` : '—');

/** Download India's road network per zone for instant, offline routing (no servers, no limits). */
export function OfflineRouting() {
  const [, tick] = useState(0);
  const [inst, setInst] = useState<Awaited<ReturnType<typeof device.installed>>>([]);
  const [meta, setMeta] = useState<Record<string, { bytes?: number; km?: number; generated?: string } | null>>({});
  const [prog, setProg] = useState<Record<string, string>>({});
  const reload = () => device.installed().then(setInst);
  useEffect(() => {
    void reload();
    const off = (() => { const f = () => tick((x) => x + 1); device.listeners.add(f); return () => { device.listeners.delete(f); }; })();
    // sizes published by the build (gz size from the server's headers)
    for (const z of ZONES) {
      void Promise.all([
        fetch(`${import.meta.env.BASE_URL}graphs/${z.zone}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(`${import.meta.env.BASE_URL}graphs/${z.zone}.rgg.gz`, { method: 'HEAD' }).then((r) => (r.ok ? +(r.headers.get('content-length') ?? 0) : 0)).catch(() => 0),
      ]).then(([j, gz]) => setMeta((m) => ({ ...m, [z.zone]: j ? { ...j, gz } : null })));
    }
    return off;
  }, []);
  return (
    <section>
      <h3>Offline routing (on-device)</h3>
      <p className="muted">Download a region's road network once (Wi-Fi recommended). Routes inside it are then calculated on this device — instant, no internet, no server limits — with two-wheeler-banned expressways, private and no-access roads left out of the road network itself.</p>
      {ZONES.map((z) => {
        const have = inst.find((i) => i.zone === z.zone);
        const m = meta[z.zone] as any;
        const p = prog[z.zone];
        return (
          <div className="item" key={z.zone}>
            <div><b>{z.label}</b> {have && <span className="pill">{device.loaded.has(z.zone) ? 'ready' : 'stored'}</span>}
              <div className="muted">{z.states}</div>
              <div className="muted">{m ? `${mb(m.gz)} download · ${mb(m.bytes)} on device · ${Math.round((m.km ?? 0) / 1000).toLocaleString('en-IN')}k km of road` : m === null ? 'not built yet' : '…'}{have?.generated ? ` · map data ${new Date(have.generated).toLocaleDateString('en-IN')}` : ''}</div></div>
            <div className="btns sm">
              {p ? <span className="muted">{p}</span> : have
                ? <><button onClick={() => act(null, () => device.remove(z.zone)).then(reload)}>Remove</button>
                    {m?.generated && have.generated !== m.generated && <button className="primary" onClick={() => dl(z.zone)}>Update</button>}</>
                : <button className="primary" disabled={!m} onClick={() => dl(z.zone)}>Download</button>}
            </div>
          </div>
        );
      })}
      <p className="muted small-note">Road data © OpenStreetMap contributors (ODbL). Regions overlap at their borders; routes that cross between two downloaded regions use the internet servers for that leg (for now).</p>
    </section>
  );
  function dl(zone: string) {
    setProg((x) => ({ ...x, [zone]: 'starting…' }));
    void device.download(zone, (d, t) => setProg((x) => ({ ...x, [zone]: t ? `${Math.round((d / t) * 100)}% (${mb(d)} of ${mb(t)})` : mb(d) })))
      .then(() => { toast('Region ready — routes there now work offline'); })
      .catch((e) => toast(e.message, 'error'))
      .finally(() => { setProg((x) => { const y = { ...x }; delete y[zone]; return y; }); void reload(); });
  }
}
