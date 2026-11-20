import { useEffect, useRef, useState } from 'react';
import { Marker } from 'maplibre-gl';
import { mapCtl } from '../ui/App';
import { watchShare, type SharePos } from './liveShare';

/** What family / friends see when they open a live-location link: the rider on a map, speed, last update. */
export function WatchView({ code }: { code: string }) {
  const [pos, setPos] = useState<SharePos | null | undefined>(undefined);
  const [, tick] = useState(0);
  const marker = useRef<Marker | null>(null);
  const first = useRef(true);
  useEffect(() => {
    let stop: (() => void) | null = null;
    void watchShare(code, setPos).then((s) => { stop = s; });
    const i = setInterval(() => tick((x) => x + 1), 15000);
    return () => { stop?.(); clearInterval(i); };
  }, [code]);
  useEffect(() => {
    const m = mapCtl?.map;
    if (!m || !pos) return;
    if (!marker.current) {
      const el = document.createElement('div'); el.className = 'watchdot'; el.textContent = '🏍';
      marker.current = new Marker({ element: el }).setLngLat(pos.p).addTo(m);
    } else marker.current.setLngLat(pos.p);
    if (first.current) { first.current = false; m.jumpTo({ center: pos.p, zoom: 14 }); } else m.easeTo({ center: pos.p, duration: 800 });
  }, [pos]);
  const ago = pos ? Math.round((Date.now() - pos.t) / 60000) : 0;
  return (
    <div className="watchpanel glass">
      {pos === undefined && <b>Connecting…</b>}
      {pos === null && <b>Location sharing has ended.</b>}
      {pos && <>
        <b>{pos.name || 'Rider'}</b> is sharing their live location
        <div className="muted">{Math.round(pos.spd * 3.6)} km/h · updated {ago < 1 ? 'just now' : `${ago} min ago`}{pos.until ? ` · sharing until ${new Date(pos.until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>
        {ago > 5 && <div className="warn">No update for {ago} minutes — the phone may be out of signal.</div>}
        <a href={`https://www.google.com/maps/dir/?api=1&destination=${pos.p[1]},${pos.p[0]}`} target="_blank" rel="noopener noreferrer">Directions to the rider</a>
      </>}
      <div className="muted small-note">RideGrid live location · end-to-end encrypted</div>
    </div>
  );
}
