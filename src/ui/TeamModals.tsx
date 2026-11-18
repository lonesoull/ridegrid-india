import { team } from '../team/team';
import { acceptRoute, stopAlarm } from '../team/actions';
import { haversine, fmtKm } from '../core/geo';
import { nav } from '../nav/navigator';
import { ui, useUI, act, toast } from './state';
import { mapCtl } from './App';

/** Full-screen SOS alarm from a team device. */
export function SosModal() {
  const e = useUI((s) => s.sos);
  if (!e || e.type !== 'sos') return null;
  const dist = nav.pos ? haversine(nav.pos, e.pos) : null;
  const close = () => { stopAlarm(); ui.set({ sos: null }); };
  return (
    <div className="modal-wrap sos-wrap">
      <div className="modal sosmodal">
        <h2>🆘 SOS from {e.name}</h2>
        <p>{new Date(e.t).toLocaleTimeString('en-IN')} · {e.pos[1].toFixed(6)}, {e.pos[0].toFixed(6)}{e.acc ? ` (±${Math.round(e.acc)} m)` : ''}{dist !== null ? ` · ${fmtKm(dist)} from you` : ''}</p>
        {e.msg && <p><b>{e.msg}</b></p>}
        <div className="btns">
          <button className="primary" onClick={() => act(null, async () => {
            stopAlarm();
            await team.send({ type: 'sos-ack', from: team.settings!.deviceId, name: team.settings!.name, to: e.from, t: Date.now() });
            toast(`${e.name} has been told you're responding`);
          })}>I'm responding</button>
          <button onClick={() => { stopAlarm(); mapCtl?.map.flyTo({ center: e.pos, zoom: 16 }); ui.set({ sos: null, drawer: false }); }}>Show on map</button>
          <button onClick={() => window.open(`https://www.google.com/maps/dir/?api=1&destination=${e.pos[1]},${e.pos[0]}&travelmode=two-wheeler`, '_blank', 'noopener')}>Navigate (Google Maps)</button>
          <button onClick={() => navigator.clipboard?.writeText(`${e.pos[1].toFixed(6)}, ${e.pos[0].toFixed(6)}`).then(() => toast('Coordinates copied'))}>Copy location</button>
        </div>
        <button className="link" onClick={close}>Close</button>
      </div>
    </div>
  );
}

/** A route pushed from another team device: load it or ignore. */
export function RouteOfferModal() {
  const o = useUI((s) => s.routeOffer);
  if (!o) return null;
  const done = () => ui.set({ routeOffer: null });
  return (
    <div className="modal-wrap">
      <div className="modal glass">
        <h3>Route from {o.name}</h3>
        <p><b>{o.title}</b> · {o.kind === 'expedition' ? 'Expedition' : 'Daily ride'} · {o.stops.length.toLocaleString('en-IN')} points</p>
        <div className="btns">
          <button className="primary" onClick={() => act('Loading route…', async () => { await acceptRoute(o, 'new'); done(); toast('Route loaded as a new trip'); setTimeout(() => mapCtl?.fitRoute(), 400); })}>Load as new trip</button>
          <button onClick={() => confirm('Replace the points of the current trip? (You can undo.)') && act('Loading route…', async () => { await acceptRoute(o, 'replace'); done(); setTimeout(() => mapCtl?.fitRoute(), 400); })}>Replace current trip</button>
          <button onClick={done}>Ignore</button>
        </div>
      </div>
    </div>
  );
}
