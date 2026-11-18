import { useEffect, useMemo, useState } from 'react';
import { engine } from '../core/engine';
import type { StopLog } from '../core/db';
import { nav } from '../nav/navigator';
import { daySummaries, deleteStopLog, evidencePack, fillMissingPlaces, STOP_LABEL, updateStopLog, type DaySummary } from '../nav/logbook';
import { download, safeName } from '../io/exporters';
import { isExpedition } from '../core/terms';
import { ui, useUI, act } from './state';
import { useAsync } from './hooks';
import { useNav } from './navHooks';
import { mapCtl } from './App';

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
  const total = days?.reduce((a, d) => a + d.km, 0) ?? 0;
  const s = nav.settings;

  return (
    <div className="stack">
      <section>
        <h3>Logbook {isExpedition() && <span className="pill">evidence</span>}</h3>
        <p className="muted">Every entry records GPS position, exact time and place name automatically. Add the odometer and photos (odometer, receipt, signed page — keep the number plate visible).</p>
        <div className="btns">
          <button className="primary" onClick={() => ui.set({ logStop: 'daystart' })}>Start day</button>
          <button className="logbtn" onClick={() => ui.set({ logStop: true })}>Log stop</button>
          <button onClick={() => ui.set({ logStop: 'dayend' })}>End day</button>
        </div>
        <div className="btns">
          <button onClick={() => act('Building printable logbook…', async () => printLogbook(trip.name, (await daySummaries(trip.id)).slice().reverse()))}>Print / save as PDF</button>
          <button onClick={() => act('Building evidence pack…', async () => download(`${safeName(trip.name)}_evidence_${new Date().toISOString().slice(0, 10)}.zip`, await evidencePack(trip.id, trip.name)))}>Evidence pack (.zip)</button>
        </div>
        <label className="field">Automatic break after standing still <b>{s.breakMin} min</b>
          <input type="range" min={2} max={30} step={1} value={s.breakMin} onChange={(e) => void nav.setSettings({ breakMin: +e.target.value })} />
        </label>
        {days && days.length > 0 && <p className="muted">{days.length} day(s) · {total.toFixed(1)} km by GPS (real rides only)</p>}
      </section>

      {!days?.length && <section><p className="muted">No entries yet. Tap <b>Start day</b> before you ride: it records time, place and odometer as the first line of today's page.</p></section>}

      {days?.map((d) => {
        const odoKm = d.start?.odoKm !== undefined && d.end?.odoKm !== undefined ? d.end.odoKm - d.start.odoKm : undefined;
        const isOpen = open === d.date || (open === null && d === days[0]);
        return (
          <section key={d.date} className="logday">
            <button className="link dayhead" onClick={() => setOpen(isOpen ? '' : d.date)}>
              <b>{dayTitle(d)}</b>
              <div className="muted">{d.km.toFixed(1)} km GPS{odoKm !== undefined ? ` · ${odoKm.toFixed(1)} km odometer` : ''} · riding {hm(d.movingMin)} · {d.breaks} breaks · {d.stops.length} stops</div>
            </button>
            {isOpen && <>
              <table className="logtable">
                <tbody>
                  <tr><th>Start</th><td>{d.start ? <>{tm(d.start.at)} · {d.start.place ?? coords(d.start)}{d.start.odoKm !== undefined && <> · odo <b>{d.start.odoKm}</b></>}</> : <span className="muted">first GPS fix {tm(d.firstAt)} — tap “Start day” to log it properly</span>}</td></tr>
                  <tr><th>End</th><td>{d.end ? <>{tm(d.end.at)} · {d.end.place ?? coords(d.end)}{d.end.odoKm !== undefined && <> · odo <b>{d.end.odoKm}</b></>}</> : <span className="muted">last GPS fix {tm(d.lastAt)}</span>}</td></tr>
                  <tr><th>Distance</th><td><b>{d.km.toFixed(2)} km</b> GPS{odoKm !== undefined && <> · <b>{odoKm.toFixed(1)} km</b> odometer</>}</td></tr>
                  <tr><th>Riding</th><td>{hm(d.movingMin)} moving · {d.breaks} breaks ({Math.round(d.breakMin)} min)</td></tr>
                </tbody>
              </table>
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
        {x.note && <div>{x.note}</div>}
        {urls.length > 0 && <div className="thumbs">{urls.map((u) => <img key={u} src={u} alt="" onClick={() => setBig(u)} />)}</div>}
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
  const rows = (d: DaySummary) => d.entries.map((x) => `<tr><td>${tm(x.at)}${x.endAt ? '–' + tm(x.endAt) : ''}</td><td>${esc(STOP_LABEL[x.type])}${x.auto ? ' (auto)' : ''}</td><td>${esc(x.place ?? coords(x))}<br><small>${coords(x)}</small></td><td>${x.odoKm ?? ''}</td><td>${esc(x.note)}</td><td>${(x.photos ?? []).map((b) => `<img src="${URL.createObjectURL(b)}">`).join('')}</td><td class="sig"></td></tr>`).join('');
  const body = days.map((d) => {
    const odo = d.start?.odoKm !== undefined && d.end?.odoKm !== undefined ? (d.end.odoKm - d.start.odoKm).toFixed(1) + ' km' : '—';
    return `<section><h2>${esc(dayTitle(d))}</h2><p>GPS distance <b>${d.km.toFixed(2)} km</b> · odometer ${odo} · riding ${hm(d.movingMin)} · ${d.breaks} breaks (${Math.round(d.breakMin)} min)</p>
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
