import { useEffect, useState } from 'react';
import { google, viewportCopyright } from '../core/google';
import { currentSession } from '../map/googleBase';
import { mapCtl } from './App';

/** Google logo + copyright for the visible area (required by Google's terms when its tiles are shown). */
export function GoogleAttribution() {
  const [text, setText] = useState('');
  const [isGoogle, setIsGoogle] = useState(false);
  useEffect(() => {
    const m = mapCtl?.map;
    if (!m) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const g = mapCtl?.base === 'google';
        setIsGoogle(g);
        const s = currentSession();
        if (!g || !s) return;
        const b = m.getBounds();
        try { setText(await viewportCopyright(google.settings.key, s, m.getZoom(), { n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest() })); }
        catch { setText('Map data ©Google'); }
      }, 1200);
    };
    m.on('moveend', update); m.on('style.load', update);
    update();
    return () => { m.off('moveend', update); m.off('style.load', update); clearTimeout(t); };
  }, []);
  if (!isGoogle) return null;
  return <div className="gattr"><b className="glogo">Google</b><span>{text || 'Map data ©Google'}</span></div>;
}
