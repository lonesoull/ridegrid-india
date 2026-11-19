import { useEffect, useState } from 'react';
import { nav } from '../nav/navigator';
import { mapCtl } from '../ui/App';
import { haversine, fmtKm, type LngLat } from '../core/geo';
import { markers } from './markers';

const RAD = Math.PI / 180;
const bearing = (a: LngLat, b: LngLat) => { const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD), x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD); return (Math.atan2(y, x) / RAD + 360) % 360; };
const dist = (m: number) => (m < 1000 ? `${Math.round(m)} m` : fmtKm(m));

/** Map markers bar (OsmAnd): an arrow pointing at each active marker + distance; parked-bike timer. */
export function MarkersBar() {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    markers.listeners.add(f); const off = nav.subscribe(f); const i = setInterval(f, 10000); mapCtl?.map.on('rotate', f);
    return () => { markers.listeners.delete(f); off(); clearInterval(i); mapCtl?.map.off('rotate', f); };
  }, []);
  const me: LngLat | null = nav.pos ?? (mapCtl ? [mapCtl.map.getCenter().lng, mapCtl.map.getCenter().lat] : null);
  const list = markers.active().slice(0, 3);
  const park = markers.parking();
  if (!me || (!list.length && !park)) return null;
  const up = nav.mode !== 'off' ? nav.heading : mapCtl?.map.getBearing() ?? 0;
  return (
    <div className="markersbar">
      {list.map((k) => (
        <button key={k.id} className="mk glass" onClick={() => mapCtl?.map.flyTo({ center: k.p, zoom: Math.max(mapCtl.map.getZoom(), 15) })}>
          <span className="arrow" style={{ color: k.color, transform: `rotate(${bearing(me, k.p) - up}deg)` }}>➤</span>
          <span><b>{dist(haversine(me, k.p))}</b><br /><small>{k.name}</small></span>
        </button>
      ))}
      {park && (
        <button className="mk glass" onClick={() => mapCtl?.map.flyTo({ center: park.p, zoom: 17 })}>
          <span className="arrow park">P</span>
          <span><b>{dist(haversine(me, park.p))}</b><br /><small>{park.until ? (park.until > Date.now() ? `${Math.ceil((park.until - Date.now()) / 60000)} min left` : 'time up!') : 'bike parked'}</small></span>
        </button>
      )}
    </div>
  );
}
