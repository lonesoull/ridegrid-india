import { useEffect, useState } from 'react';
import { bikes, resetBikeStatus } from './profiles';
import { sensors } from './sensors';
import { access } from './access';
import { makeBundle, applyBundle } from './syncBackup';
import { createOsmNote, osmNotesNear, osmEditUrl } from './osm';
import { team } from '../team/team';
import { download } from '../io/exporters';
import { mapCtl } from '../ui/App';
import { act, toast } from '../ui/state';
import { nav } from '../nav/navigator';
import type { LngLat } from '../core/geo';
import { liveShare } from './liveShare';
import { obd } from './obd';
import { resetSetup } from './SetupWizard';
import { extras, BTN_LABEL, type BtnAction, type Extras } from './extras';
import type { CoordFormat } from './coords';

/** Daily "Settings & devices": bike profiles, Bluetooth sensors, sync/backup, accessibility, OpenStreetMap. */
export function DailyControl() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((x) => x + 1); bikes.listeners.add(f); sensors.listeners.add(f); obd.listeners.add(f); return () => { bikes.listeners.delete(f); sensors.listeners.delete(f); obd.listeners.delete(f); }; }, []);
  const b = bikes.active;
  const num = (k: keyof typeof b, label: string, unit: string) => (
    <label className="field">{label} ({unit})<input type="number" inputMode="decimal" defaultValue={b[k] as number} key={b.id + k} onBlur={(e) => void bikes.update({ [k]: +e.target.value } as any).then(resetBikeStatus)} /></label>
  );
  const here = (): LngLat => nav.pos ?? [mapCtl!.map.getCenter().lng, mapCtl!.map.getCenter().lat];
  const [notes, setNotes] = useState<{ id: number; text: string; url: string }[] | null>(null);
  return (
    <>
      <LiveShare />

      <section>
        <h3>My bikes</h3>
        <select value={bikes.activeId} onChange={(e) => act('Switching bike…', () => bikes.switchTo(e.target.value)).then(() => tick((x) => x + 1))}>
          {bikes.list.map((x) => <option key={x.id} value={x.id}>{x.name}{x.reg ? ` · ${x.reg}` : ''}</option>)}
        </select>
        <p className="muted">Each bike keeps its own route options, map style, widgets and quick buttons.</p>
        <label className="field">Name<input defaultValue={b.name} key={b.id + 'n'} onBlur={(e) => void bikes.update({ name: e.target.value || 'My bike' })} /></label>
        <div className="grid2">
          <label className="field">Model<input defaultValue={b.model} key={b.id + 'm'} onBlur={(e) => void bikes.update({ model: e.target.value })} /></label>
          <label className="field">Registration<input defaultValue={b.reg} key={b.id + 'r'} onBlur={(e) => void bikes.update({ reg: e.target.value.toUpperCase() })} /></label>
          {num('tankL', 'Tank', 'litres')}{num('kmpl', 'Mileage', 'km/l')}
          {num('serviceEveryKm', 'Service every', 'km')}{num('wheelMm', 'Wheel circumference', 'mm')}
        </div>
        <div className="btns">
          <button onClick={() => act(null, async () => { const l = prompt('Litres in the tank now (full tank = ' + b.tankL + ')', String(b.tankL)); if (l) { await bikes.update({ fuelLeftL: +l, fuelAt: Date.now() }); resetBikeStatus(); toast('Fuel range reset'); } })}>⛽ Filled fuel</button>
          <button onClick={() => act(null, async () => { await bikes.update({ lastServiceAt: Date.now() }); resetBikeStatus(); toast('Service logged'); })}>🔧 Serviced today</button>
          <button onClick={() => act(null, async () => { const n = prompt('New bike name'); if (n) { const nb = await bikes.add(n); await bikes.switchTo(nb.id); } })}>+ Add bike</button>
          {bikes.list.length > 1 && <button className="danger" onClick={() => confirm(`Remove ${b.name}?`) && void bikes.remove(b.id)}>Remove bike</button>}
        </div>
        <p className="muted">Add the “Fuel range” and “Next service” widgets in Map → Configure screen.</p>
      </section>

      <section>
        <h3>Bluetooth sensors</h3>
        <div className="btns">
          <button onClick={() => act('Pairing…', () => sensors.pair('hr'))}>♥ Heart-rate strap</button>
          <button onClick={() => act('Pairing…', () => sensors.pair('csc'))}>⚙ Speed / cadence</button>
          <button onClick={() => act('Pairing…', () => sensors.pair('temp'))}>🌡 Temperature</button>
        </div>
        {sensors.devices.map((d) => <div key={d.id} className="item"><span>{d.name} · {d.kind}{d.battery !== undefined ? ` · 🔋${d.battery}%` : ''}</span><button className="sm" onClick={() => void sensors.forget(d.id)}>Disconnect</button></div>)}
        <p className="muted">Standard Bluetooth LE sensors. Show their values with the sensor widgets (Map → Configure screen).</p>
        <div className="btns">
          {obd.on ? <button onClick={() => act(null, () => obd.disconnect())}>Disconnect OBD ({obd.name})</button>
            : <button onClick={() => act('Connecting to the OBD adapter…', () => obd.connect())}>🔧 Connect OBD-II adapter (Bluetooth LE)</button>}
        </div>
        {obd.on && <p className="muted">{Object.entries(obd.values).map(([k, v]) => `${k} ${typeof v === 'number' ? Math.round(v * 10) / 10 : v}`).join(' · ') || 'Reading…'}</p>}
        <p className="muted small-note">OBD needs a Bluetooth LE (BLE) ELM327 adapter in the bike's OBD port (BS6 bikes); classic-Bluetooth adapters can't be used by apps like this.</p>
      </section>

      <section>
        <h3>Sync & backup</h3>
        <div className="btns">
          <button disabled={!team.settings} onClick={() => act('Sending…', async () => { const s = team.settings!; await team.send({ type: 'daily-sync', from: s.deviceId, name: s.name, bundle: await makeBundle() }); toast('Sent to your linked devices'); })}>📡 Send places & settings to my devices</button>
          <button onClick={() => act(null, async () => download(`ridegrid-daily-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(await makeBundle(), null, 1)], { type: 'application/json' })))}>⬇ Export settings & places</button>
          <label className="photo-btn sm">
            <input type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void act('Importing…', async () => { await applyBundle(JSON.parse(await f.text())); toast('Settings & places restored'); }); }} />
            ⬆ Import
          </label>
        </div>
        {!team.settings && <p className="muted">Link your devices in the Team tab to send places and settings between them.</p>}
      </section>

      <RideExtras />

      <section>
        <h3>Setup</h3>
        <button onClick={() => { resetSetup(); window.dispatchEvent(new Event('ridegrid:setup')); }}>Run the setup steps again</button>
      </section>

      <section>
        <h3>Accessibility</h3>
        <label className="field">Text & button size <b>{Math.round(access.s.scale * 100)}%</b>
          <input type="range" min={1} max={1.6} step={0.1} value={access.s.scale} onChange={(e) => void access.save({ scale: +e.target.value }).then(() => tick((x) => x + 1))} />
        </label>
        <label className="check"><input type="checkbox" checked={access.s.contrast} onChange={(e) => void access.save({ contrast: e.target.checked }).then(() => tick((x) => x + 1))} /><span>High contrast</span></label>
        <label className="check"><input type="checkbox" checked={access.s.vibrate} onChange={(e) => void access.save({ vibrate: e.target.checked }).then(() => tick((x) => x + 1))} /><span>Vibrate on turns and road alerts</span></label>
      </section>

      <section>
        <h3>Improve the map (OpenStreetMap)</h3>
        <p className="muted">Missing road, wrong one-way, closed petrol pump? Leave a note for OpenStreetMap mappers (no account needed) or edit the map yourself.</p>
        <div className="btns">
          <button onClick={() => act('Sending…', async () => { const t = prompt('What is wrong or missing here?'); if (!t) return; const id = await createOsmNote(here(), t); toast(`Thanks — note #${id ?? ''} sent to OpenStreetMap`); })}>📝 Report a map problem here</button>
          <button onClick={() => act('Loading…', async () => setNotes(await osmNotesNear(here())))}>Open notes nearby</button>
          <button onClick={() => window.open(osmEditUrl(here()), '_blank', 'noopener')}>✏ Edit in OpenStreetMap</button>
        </div>
        {notes && (notes.length ? notes.map((n) => <div key={n.id} className="item"><span>{n.text.slice(0, 100)}</span><a href={n.url} target="_blank" rel="noopener noreferrer">open</a></div>) : <p className="muted">No open notes nearby.</p>)}
      </section>
    </>
  );
}

/** Live location link for family / friends (OsmAnd live monitoring). */
function LiveShare() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((x) => x + 1); liveShare.listeners.add(f); return () => { liveShare.listeners.delete(f); }; }, []);
  const [hours, setHours] = useState(8);
  const share = async (link: string) => {
    const text = `Follow my ride live: ${link}`;
    if ((navigator as any).share) { try { await (navigator as any).share({ title: 'My live location', text, url: link }); return; } catch { /* cancelled */ } }
    try { await navigator.clipboard.writeText(link); toast('Link copied'); } catch { prompt('Copy this link', link); }
  };
  return (
    <section>
      <h3>Share live location</h3>
      {liveShare.on ? <>
        <p>🟢 <b>Sharing</b>{liveShare.until ? ` until ${new Date(liveShare.until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''} · {liveShare.sent} updates sent</p>
        <div className="btns">
          <button className="primary" onClick={() => void share(liveShare.link())}>Send the link (WhatsApp, SMS…)</button>
          <button className="danger" onClick={() => act(null, () => liveShare.stop())}>Stop sharing</button>
        </div>
      </> : <>
        <p className="muted">Family or friends open a link and watch you ride on a map — no app or account needed. Updates every 10 s, end-to-end encrypted; the key is only in the link.</p>
        <label className="field">Share for
          <select value={hours} onChange={(e) => setHours(+e.target.value)}>
            <option value={1}>1 hour</option><option value={4}>4 hours</option><option value={8}>8 hours</option><option value={24}>24 hours</option><option value={0}>Until I stop</option>
          </select></label>
        <button className="primary" onClick={() => act('Starting…', async () => { const name = (team.settings?.name || bikes.active.name || 'Rider'); const link = await liveShare.start(hours, name); await share(link); })}>Start sharing</button>
      </>}
    </section>
  );
}

/** OsmAnd-style riding extras that Google Maps does not have. */
function RideExtras() {
  const [, tick] = useState(0);
  const [learn, setLearn] = useState<BtnAction | null>(null);
  const x = extras.s;
  const set = (p: Partial<Extras>) => void extras.save(p).then(() => tick((n) => n + 1));
  useEffect(() => {
    if (!learn) return;
    const f = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); const keys = Object.fromEntries(Object.entries(x.keys).filter(([, a]) => a !== learn)); keys[e.key] = learn; set({ keys }); setLearn(null); toast(`“${e.key}” now does: ${BTN_LABEL[learn]}`); };
    window.addEventListener('keydown', f, true);
    return () => window.removeEventListener('keydown', f, true);
  }, [learn]);
  const chk = (k: keyof Extras, label: string) => <label className="check"><input type="checkbox" checked={!!x[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<Extras>)} /><span>{label}</span></label>;
  return (
    <section>
      <h3>Riding extras</h3>
      {chk('notify', 'Show the next turn in the phone notification bar')}
      {chk('wakeScreen', 'Wake the screen just before each turn')}
      {chk('lightNight', 'Night map from the light sensor (tunnels, dark clouds)')}
      {chk('autoRecord', 'Record my track automatically when I start riding')}
      {chk('avoidBorders', 'Avoid crossing country borders — Nepal, Bhutan, Bangladesh… (Google cannot do this, so routes then come from the other routers)')}
      <label className="field">Coordinate format
        <select value={x.coordFormat} onChange={(e) => set({ coordFormat: e.target.value as CoordFormat })}>
          <option value="dec">Decimal (12.97160, 77.59460)</option><option value="dms">Degrees-minutes-seconds</option><option value="utm">UTM</option><option value="olc">Plus code</option>
        </select>
      </label>
      <label className="field">Route line colour <input type="color" value={x.routeColor} onChange={(e) => set({ routeColor: e.target.value })} /></label>
      <label className="field">Route line thickness <b>{Math.round(x.routeWidth * 100)}%</b>
        <input type="range" min={0.6} max={2.5} step={0.1} value={x.routeWidth} onChange={(e) => set({ routeWidth: +e.target.value })} />
      </label>
      {chk('showAvoided', 'Show the roads I chose to avoid on the map (red ⛔ line)')}
      <label className="field">Size of RideGrid map labels <b>{Math.round(x.textScale * 100)}%</b>
        <input type="range" min={0.8} max={1.8} step={0.1} value={x.textScale} onChange={(e) => set({ textScale: +e.target.value })} />
      </label>
      <details>
        <summary>Handlebar remote / Bluetooth buttons</summary>
        <p className="hint">Pair the remote with the phone. Tap “Set”, then press the button on the remote.</p>
        {(Object.keys(BTN_LABEL) as BtnAction[]).map((a) => {
          const keys = Object.entries(x.keys).filter(([, v]) => v === a).map(([k]) => (k === ' ' ? 'Space' : k));
          return <div key={a} className="row"><span style={{ flex: 1 }}>{BTN_LABEL[a]} <span className="muted">{keys.join(', ') || '—'}</span></span>
            <button className="sm" onClick={() => setLearn(a)}>{learn === a ? 'Press a button…' : 'Set'}</button></div>;
        })}
      </details>
    </section>
  );
}
