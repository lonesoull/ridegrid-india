import { useEffect, useRef, useState } from 'react';
import type { LngLat } from '../core/geo';
import { mapCtl } from '../ui/App';
import { act, toast } from '../ui/state';
import { showTrack } from './trackTools';
import { googleReady, openInGoogleMaps, openStreetView, placePhotos, streetViewPhoto, googleWalk } from './gfeatures';

/** Daily place card extras from Google: Street View, photos, open in the Google Maps app, walking route. */
export function GooglePlaceExtras({ p, placeId, name, from }: { p: LngLat; placeId?: string; name: string; from: () => Promise<LngLat> }) {
  const [sv, setSv] = useState<string | null>(null);
  const [photos, setPhotos] = useState<{ url: string; credit: string }[] | null>(null);
  const [pano, setPano] = useState(false);
  const panoEl = useRef<HTMLDivElement>(null);
  const ok = googleReady();
  useEffect(() => { setSv(null); setPhotos(null); if (ok) void streetViewPhoto(p).then(setSv).catch(() => setSv(null)); }, [p[0], p[1], ok]);
  useEffect(() => { if (pano && panoEl.current) void openStreetView(panoEl.current, p).catch((e) => { toast(e.message, 'error'); setPano(false); }); }, [pano]);
  return (
    <div className="gextras">
      <div className="btns sm">
        <button onClick={() => openInGoogleMaps(p, placeId, name)}>Open in Google Maps (ratings, hours, reviews)</button>
        {ok && placeId && !photos && <button onClick={() => act(null, async () => setPhotos(await placePhotos(placeId)))}>📷 Photos</button>}
        {ok && <button onClick={() => act('Walking route…', async () => {
          const w = await googleWalk(await from(), p);
          if (mapCtl) showTrack(mapCtl, { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { c: '#1971c2' }, geometry: { type: 'LineString', coordinates: w.coords } }] });
          toast(`Walk ${w.distM < 1000 ? `${Math.round(w.distM)} m` : `${(w.distM / 1000).toFixed(1)} km`} · about ${Math.round(w.minutes)} min`);
        })}>🚶 Walk here</button>}
      </div>
      {sv && !pano && <button className="svthumb" onClick={() => setPano(true)} title="Open Street View"><img src={sv} alt="Street View" /><span>Street View ▸</span></button>}
      {pano && <div className="panowrap"><div ref={panoEl} className="pano" /><button className="x" onClick={() => setPano(false)}>✕</button></div>}
      {photos && (photos.length ? <div className="gphotos">{photos.map((ph) => <figure key={ph.url}><img src={ph.url} alt={name} loading="lazy" /><figcaption>{ph.credit}</figcaption></figure>)}</div> : <p className="muted">No photos for this place.</p>)}
    </div>
  );
}
