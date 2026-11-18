import { useEffect, useMemo, useState } from 'react';
import { engine } from '../core/engine';
import type { StopLog } from '../core/db';
import { nav } from '../nav/navigator';
import { daySummaries, deleteStopLog, evidencePack, fillMissingPlaces, STOP_LABEL, updateStopLog, RECORD_KM, totalIndiaKm, dayKey, type DaySummary } from '../nav/logbook';
import { download, safeName } from '../io/exporters';
import { isExpedition } from '../core/terms';
import { ui, useUI, act } from './state';
import { useAsync } from './hooks';
import { useNav } from './navHooks';
import { mapCtl } from './App';

/** Which days' evidence has been downloaded off this phone (per device; a convenience reminder only). */
const BK = (tripId: string) => `ridegrid.backup.${tripId}`;
export function backups(tripId: string): string[] { try { return JSON.parse(localStorage.getItem(BK(tripId)) ?? '[]'); } catch { return []; } }
export function markBackup(tripId: string, date: string) { try { localStorage.setItem(BK(tripId), JSON.stringify([...new Set([...backups(tripId), date])])); } catch { /* private mode */ } }

const tm = (t?: number) => (t ? new Date(t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—');
const dayTitle = (d: DaySummary) => `Day ${d.dayNo} · ${new Date(d.date + 'T00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}`;
const hm = (min: number) => `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`;

/** The expedition logbook: one page per day, like the paper logbook officials sign. */
export function LogbookTab() {
  useNav();
  const trip = engine.trip!;
  const dialogOpen = useUI((x) => !!x.logStop);
  const [days, reload] = useAsync(() => daySummaries(trip.id), [trip.id, nav.mode, nav.version >> 6, dialogOpen]);
  // place names arrive a moment after saving — refresh once more
  useEffect(() => { if (!dialogOpen) { const t = setTimeout(reload, 2500); return () => clearTimeout(t); } }, [dialogOpen]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { void fillMissingPlaces(trip.id).then(reload); }, [trip.id]);
  const total = days ? totalIndiaKm(days) : 0;
  const s = nav.settings;
  const [, bump] = useState(0);
  const saved = backups(trip.id);
  const today = dayKey(Date.now());
  const notBacked = (days ?? []).filter((d) => d.date !== today && d.km > 1 && !saved.includes(d.date));
  const dayPack = (d: DaySummary) => act(`Building Day ${d.dayNo} evidence…`, async () => {
    download(`${safeName(trip.name)}_evidence_day${String(d.dayNo).padStart(3, '0')}_${d.date}.zip`, await evidencePack(trip.id, trip.name, d.date));
    markBackup(trip.id, d.date); bump((x) => x + 1);
  });

  return (
    <div className="stack">
      <section>
        <h3>Logbook {isExpedition() && <span className="pill">evidence</span>}</h3>
        <p className="muted">Every entry records GPS position, exact time and place name automatically. Add the odometer and photos (odometer, bill, signed page — keep the number plate visible).</p>
        {isExpedition() && days && (
          <div className="record">
            <div><b>{total.toLocaleString('en-IN', { maximumFractionDigits: 1 })} km</b> by GPS inside India · record to beat <b>{RECORD_KM.toLocaleString('en-IN')} km</b></div>
            <div className="bar"><i style={{ width: `${Math.min(100, (total / RECORD_KM) * 100)}%` }} /></div>
            <div className="muted">{total < RECORD_KM ? `${(RECORD_KM - total).toLocaleString('en-IN', { maximumFractionDigits: 1 })} km to go` : `Record passed by ${(total - RECORD_KM).toLocaleString('en-IN', { maximumFractionDigits: 1 })} km — keep riding to your planned finish`}</div>
          </div>
        )}
        {notBacked.length > 0 && <div className="warnbox">⚠ {notBacked.length} day(s) of evidence are only on this phone. Download each day's pack (button on the day) and keep it on your laptop / Google Drive.</div>}
        <div className="btns">
          <button className="primary" onClick={() => ui.set({ logStop: 'daystart' })}>Start day</button>
          <button className="logbtn" onClick={() => ui.set({ logStop: true })}>Log stop</button>
          <button onClick={() => ui.set({ logStop: 'dayend' })}>End day</button>
        </div>
        <div className="btns">
          <button onClick={() => ui.set({ logStop: 'police' })}>Witness / police</button>
          <button onClick={() => ui.set({ logStop: 'evidence' })}>📷 Evidence</button>
          <button onClick={() => ui.set({ logStop: 'fuel' })}>Bill</button>
          <button onClick={() => ui.set({ logStop: 'media' })}>Media</button>
        </div>
        <div className="btns">
          <button onClick={() => act('Building printable logbook…', async () => printLogbook(trip.name, (await daySummaries(trip.id)).slice().reverse()))}>Print / save as PDF</button>
          <button onClick={() => act('Building evidence pack…', async () => download(`${safeName(trip.name)}_evidence_all_${new Date().toISOString().slice(0, 10)}.zip`, await evidencePack(trip.id, trip.name)))}>Whole-journey evidence (.zip)</button>
        </div>
        <label className="field">Automatic break after standing still <b>{s.breakMin} min</b>
          <input type="range" min={2} max={30} step={1} value={s.breakMin} onChange={(e) => void nav.setSettings({ breakMin: +e.target.value })} />
        </label>
        <label className="field">Evidence photo reminder while riding <b>{s.evidenceMin ? `every ${s.evidenceMin} min` : 'off'}</b>
          <input type="range" min={0} max={180} step={15} value={s.evidenceMin} onChange={(e) => void nav.setSettings({ evidenceMin: +e.target.value })} />
        </label>
        {days && days.length > 0 && <p className="muted">{days.length} day(s) · {total.toFixed(1)} km by GPS inside India (real rides only)</p>}
      </section>

      {!days?.length && <section><p className="muted">No entries yet. Tap <b>Start day</b> before you ride: it records time, place and odometer as the first line of today's page.</p></section>}

      {days?.map((d) => {
        const odoKm = d.start?.odoKm !== undefined && d.end?.odoKm !== undefined ? d.end.odoKm - d.start.odoKm : undefined;
        const isOpen = open === d.date || (open === null && d === days[0]);
        return (
          <section key={d.date} className="logday">
            <button className="link dayhead" onClick={() => setOpen(isOpen ? '' : d.date)}>
              <b>{dayTitle(d)}</b>
              <div className="muted">{d.kmIndia.toFixed(1)} km GPS{odoKm !== undefined ? ` · ${odoKm.toFixed(1)} km odometer` : ''} · riding {hm(d.movingMin)} · {d.witnesses} witness · {d.evidence} evidence · {d.breaks} breaks
                {d.issues.length > 0 && <span className="warn"> · ⚠ {d.issues.length} to check</span>}{saved.includes(d.date) && ' · ✓ backed up'}</div>
            </button>
            {isOpen && <>
              <table className="logtable">
                <tbody>
                  <tr><th>Start</th><td>{d.start ? <>{tm(d.start.at)} · {d.start.place ?? coords(d.start)}{d.start.odoKm !== undefined && <> · odo <b>{d.start.odoKm}</b></>}</> : <span className="muted">first GPS fix {tm(d.firstAt)} — tap “Start day” to log it properly</span>}</td></tr>
                  <tr><th>End</th><td>{d.end ? <>{tm(d.end.at)} · {d.end.place ?? coords(d.end)}{d.end.odoKm !== undefined && <> · odo <b>{d.end.odoKm}</b></>}</> : <span className="muted">last GPS fix {tm(d.lastAt)}</span>}</td></tr>
                  <tr><th>Distance</th><td><b>{d.kmIndia.toFixed(2)} km</b> GPS in India{d.kmOutside > 0.05 && <> · {d.kmOutside.toFixed(2)} km outside / unclear border</>}{odoKm !== undefined && <> · <b>{odoKm.toFixed(1)} km</b> odometer</>}</td></tr>
                  {d.startGapKm !== undefined && <tr><th>Continuity</th><td>{d.startGapKm <= 1 ? `✓ started where the previous day ended (${Math.round(d.startGapKm * 1000)} m)` : <span className="warn">started {d.startGapKm.toFixed(1)} km from the previous day's end</span>}</td></tr>}
                  <tr><th>Riding</th><td>{hm(d.movingMin)} moving · {d.breaks} breaks ({Math.round(d.breakMin)} min)</td></tr>
                </tbody>
              </table>
              {d.issues.length > 0 && <div className="warnbox"><b>Check before submitting:</b><ul>{d.issues.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
              <div className="btns sm"><button onClick={() => dayPack(d)}>{saved.includes(d.date) ? '✓ Download again' : "Download this day's evidence"}</button></div>
              <div className="timeline">
                {d.entries.map((x) => <Entry key={x.id} x={x} onChange={reload} />)}
              </div>
            </>}
          </section>
        );
      })}
    </div>
  );
}

const coords = (x: StopLog) => `${x.lat.toFixed(5)}, ${x.lng.toFixed(5)}`;

function Entry({ x, onChange }: { x: StopLog; onChange: () => void }) {
  const urls = useMemo(() => (x.photos ?? []).map((b) => URL.createObjectURL(b)), [x.photos]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const [big, setBig] = useState<string | null>(null);
  return (
    <div className={`entry t-${x.type}`}>
      <div className="etime">{tm(x.at)}{x.endAt ? <><br />{tm(x.endAt)}</> : null}</div>
      <div className="ebody">
        <b>{STOP_LABEL[x.type]}</b>{x.auto && <span className="muted"> · automatic</span>}{x.endAt && <span className="muted"> · {Math.round((x.endAt - x.at) / 60000)} min</span>}
        <div className="muted">{x.place ?? coords(x)}{x.odoKm !== undefined ? ` · odo ${x.odoKm} km` : ''}</div>
        {x.witness && <div>✍ <b>{x.witness.name}</b>{x.witness.role ? `, ${x.witness.role}` : ''}{x.witness.org ? `, ${x.witness.org}` : ''}{x.witness.gazetted ? ' · gazetted' : ''}{x.witness.independent ? ' · independent' : ''}</div>}
        {x.note && <div>{x.note}</div>}
        {x.link && <div><a href={x.link} target="_blank" rel="noopener noreferrer">{x.link}</a></div>}
        {urls.length > 0 && <div className="thumbs">{urls.map((u, i) => (x.photos![i].type.startsWith('video/')
          ? <video key={u} src={u} controls preload="metadata" />
          : <img key={u} src={u} alt="" onClick={() => setBig(u)} />))}</div>}
        <div className="btns sm">
          <button onClick={() => { mapCtl?.map.flyTo({ center: [x.lng, x.lat], zoom: 16 }); ui.set({ drawer: false }); }}>Map</button>
          <button onClick={() => { const n = prompt('Note', x.note ?? ''); if (n !== null) void updateStopLog(x.id, { note: n || undefined }).then(onChange); }}>Note</button>
          <button className="danger" onClick={() => confirm(`Delete this ${STOP_LABEL[x.type]} entry?`) && deleteStopLog(x.id).then(onChange)}>Delete</button>
        </div>
      </div>
      {big && <div className="modal-wrap" onClick={() => setBig(null)}><img className="bigphoto" src={big} alt="" /></div>}
    </div>
  );
}

/** Printable logbook (one table per day) → the browser's print dialog, where "Save as PDF" works. */
function printLogbook(name: string, days: DaySummary[]) {
  const w = window.open('', '_blank');
  if (!w) throw new Error('Allow pop-ups to print the logbook');
  const esc = (s: unknown) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
  const rows = (d: DaySummary) => d.entries.map((x) => `<tr><td>${tm(x.at)}${x.endAt ? '–' + tm(x.endAt) : ''}</td><td>${esc(STOP_LABEL[x.type])}${x.auto ? ' (auto)' : ''}</td><td>${esc(x.place ?? coords(x))}<br><small>${coords(x)}</small></td><td>${x.odoKm ?? ''}</td><td>${x.witness ? `<b>${esc(x.witness.name)}</b>${x.witness.role ? ', ' + esc(x.witness.role) : ''}${x.witness.org ? ', ' + esc(x.witness.org) : ''}<br>` : ''}${esc(x.note)}${x.link ? '<br>' + esc(x.link) : ''}</td><td>${(x.photos ?? []).filter((b) => b.type.startsWith('image/')).map((b) => `<img src="${URL.createObjectURL(b)}">`).join('')}</td><td class="sig"></td></tr>`).join('');
  const body = days.map((d) => {
    const odo = d.start?.odoKm !== undefined && d.end?.odoKm !== undefined ? (d.end.odoKm - d.start.odoKm).toFixed(1) + ' km' : '—';
    return `<section><h2>${esc(dayTitle(d))}</h2><p>GPS distance in India <b>${d.kmIndia.toFixed(2)} km</b> · odometer ${odo} · riding ${hm(d.movingMin)} · ${d.breaks} breaks (${Math.round(d.breakMin)} min)</p>
      <table><thead><tr><th>Time</th><th>Entry</th><th>Place</th><th>Odometer</th><th>Note</th><th>Photos</th><th>Witness signature / stamp</th></tr></thead><tbody>${rows(d)}</tbody></table></section>`;
  }).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)} – Logbook</title><style>
    body{font:12px system-ui,sans-serif;margin:24px;color:#111} h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:18px 0 4px}
    table{width:100%;border-collapse:collapse;margin-bottom:8px} th,td{border:1px solid #999;padding:4px 6px;vertical-align:top;text-align:left}
    th{background:#eee} td img{width:70px;height:70px;object-fit:cover;margin:2px} td.sig{width:140px} section{page-break-inside:avoid} small{color:#555}
  </style></head><body><h1>${esc(name)} — Logbook</h1><p>Generated ${new Date().toLocaleString('en-IN')} by RideGrid India. Times are local (IST); GPS tracks with UTC timestamps are in the evidence pack.</p>${body}
  <script>setTimeout(()=>print(),500)</script></body></html>`);
  w.document.close();
}
