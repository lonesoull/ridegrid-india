import { useEffect, useRef, useState } from 'react';
import { getSetting, putSetting } from '../core/db';
import { nav } from '../nav/navigator';
import { mapCtl } from '../ui/App';
import { ui, act, toast } from '../ui/state';
import { applyBase } from '../map/googleBase';
import { markers } from './markers';
import { recorder } from './recorder';
import { dailyMap } from './mapLayers';
import { myLocation } from '../nav/directions';
import type { LngLat } from '../core/geo';
import { StarChart } from './StarChart';
import { whereAmI } from './extras';
import { handoff } from '../nav/handoff';

/** OsmAnd "Quick actions": user-chosen one-tap buttons on the Daily map. */
export type QA = 'fav' | 'marker' | 'park' | 'note' | 'photo' | 'audio' | 'rec' | 'voice' | 'night' | 'style' | 'hideplaces' | 'search' | 'nav' | 'zoomin' | 'zoomout' | 'mylocation' | 'lock' | 'stars' | 'whereami' | 'gnext';
export const QA_LABEL: Record<QA, string> = { fav: '★ Add favourite here', marker: '⚑ Marker at map centre', park: 'P Park bike here', note: '✎ Text note here', photo: '📷 Photo note here',
  audio: '🎙 Voice note here', rec: '● Start / stop recording', voice: '🔊 Voice on / off', night: '🌙 Day / night', style: '🗺 Next map style', hideplaces: '👁 Show / hide my places',
  search: '🔍 Search', nav: '🧭 Navigate / stop', zoomin: '＋ Zoom in', zoomout: '－ Zoom out', mylocation: '◎ My location', lock: '🔒 Lock screen (no accidental taps)', stars: '🌌 Star chart', whereami: '📍 Where am I? (spoken)', gnext: '🗺 Next 10 stops in Google Maps' };
export const DEFAULT_QA: QA[] = ['lock', 'park', 'marker', 'rec'];
const ICON: Record<QA, string> = { fav: '★', marker: '⚑', park: 'P', note: '✎', photo: '📷', audio: '🎙', rec: '●', voice: '🔊', night: '🌙', style: '🗺', hideplaces: '👁', search: '🔍', nav: '🧭', zoomin: '＋', zoomout: '－', mylocation: '◎', lock: '🔒', stars: '🌌', whereami: '📍', gnext: 'G' };

export const quick = {
  list: [...DEFAULT_QA] as QA[], hidePlaces: false,
  listeners: new Set<() => void>(),
  async load() { this.list = await getSetting('quickActions', [...DEFAULT_QA]); },
  async save(list: QA[]) { this.list = list; await putSetting('quickActions', list); this.listeners.forEach((f) => f()); },
};

async function here(): Promise<LngLat> {
  if (nav.pos) return nav.pos;
  try { return await myLocation(); } catch { const c = mapCtl!.map.getCenter(); return [c.lng, c.lat]; }
}
const centre = (): LngLat => { const c = mapCtl!.map.getCenter(); return [c.lng, c.lat]; };

export function QuickActions() {
  const [, tick] = useState(0);
  const photo = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState<MediaRecorder | null>(null);
  const [locked, setLocked] = useState(false);
  const [stars, setStars] = useState(false);
  useEffect(() => { void quick.load().then(() => tick((x) => x + 1)); const f = () => tick((x) => x + 1); quick.listeners.add(f); recorder.listeners.add(f); return () => { quick.listeners.delete(f); recorder.listeners.delete(f); }; }, []);

  const run = (a: QA) => {
    switch (a) {
      case 'fav': return act(null, async () => { const p = await here(); const n = prompt('Favourite name', 'Favourite'); if (n) { await markers.put({ kind: 'fav', name: n, p, group: 'Favourites' }); toast('Saved to favourites'); } });
      case 'marker': return act(null, async () => { await markers.put({ kind: 'marker', name: `Marker ${markers.active().length + 1}`, p: centre(), active: true }); toast('Marker added at map centre'); });
      case 'park': return act(null, async () => { const p = await here(); const m = prompt('Parked. Remind me in how many minutes? (blank = no reminder)', ''); await markers.put({ kind: 'parking', name: 'My bike', p, until: m ? Date.now() + +m * 60000 : undefined }); toast('Parking spot saved'); });
      case 'note': return act(null, async () => { const p = await here(); const t = prompt('Note'); if (t) { await markers.put({ kind: 'note', name: t.slice(0, 40), note: t, p }); toast('Note saved on the map'); } });
      case 'photo': photo.current?.click(); return;
      case 'audio': return toggleAudio();
      case 'rec': return act(null, () => (recorder.on ? recorder.stop() : recorder.start())).then(() => toast(recorder.on ? 'Recording track' : 'Track saved in Tracks'));
      case 'voice': return act(null, () => nav.setSettings({ voice: !nav.settings.voice })).then(() => toast(nav.settings.voice ? 'Voice on' : 'Voice off'));
      case 'night': ui.set({ night: !ui.get().night }); return;
      case 'style': { const order = ['day', 'touring', 'topo', 'offroad', 'night'] as const; const i = order.indexOf(dailyMap.settings.style as any); return act(null, async () => { await dailyMap.save({ style: order[(i + 1) % order.length] }); if (mapCtl) await applyBase(mapCtl, true); }); }
      case 'hideplaces': quick.hidePlaces = !quick.hidePlaces; markers.emit(); return;
      case 'search': (document.querySelector('.search input') as HTMLInputElement | null)?.focus(); return;
      case 'nav': if (nav.mode !== 'off') void nav.stop(); else ui.set({ drawer: true, tab: 'ride' }); return;
      case 'zoomin': mapCtl?.map.zoomIn(); return;
      case 'zoomout': mapCtl?.map.zoomOut(); return;
      case 'mylocation': void here().then((p) => mapCtl?.showMe(p)); return;
      case 'lock': setLocked(true); return;
      case 'stars': setStars(true); return;
      case 'whereami': void whereAmI(); return;
      case 'gnext': handoff.open(); return;
    }
  };
  async function toggleAudio() {
    if (recording) { recording.stop(); setRecording(null); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream); const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); const p = await here(); await markers.put({ kind: 'note', name: `Voice note ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`, p, media: [new Blob(chunks, { type: rec.mimeType })] }); toast('Voice note saved on the map'); };
      rec.start(); setRecording(rec); toast('Recording voice note — tap 🎙 again to stop');
    } catch { toast('Microphone not available', 'error'); }
  }
  if (locked) return <ScreenLock onUnlock={() => setLocked(false)} />;
  if (stars) return <StarChart onClose={() => setStars(false)} />;
  if (!quick.list.length) return null;
  return (
    <div className="quickacts">
      <input ref={photo} type="file" accept="image/*,video/*" capture="environment" hidden onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) void act(null, async () => { const p = await here(); await markers.put({ kind: 'note', name: `Photo ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`, p, media: f }); toast('Photo note saved on the map'); }); }} />
      {quick.list.map((a) => (
        <button key={a} className={`fab glass qa ${a === 'rec' && recorder.on ? 'rec-on' : ''} ${a === 'audio' && recording ? 'rec-on' : ''}`} title={QA_LABEL[a]} onClick={() => void run(a)}>{ICON[a]}</button>
      ))}
    </div>
  );
}

/** OsmAnd screen lock: blocks every touch on the map while riding; hold the button 1.5 s to unlock. */
function ScreenLock({ onUnlock }: { onUnlock: () => void }) {
  const [hold, setHold] = useState(0);
  const t = useRef<number | null>(null);
  const start = () => { const t0 = Date.now(); t.current = window.setInterval(() => { const p = (Date.now() - t0) / 1500; setHold(p); if (p >= 1) { clearInterval(t.current!); onUnlock(); } }, 50); };
  const stop = () => { if (t.current) clearInterval(t.current); setHold(0); };
  return (
    <div className="screenlock" onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
      <button className="unlock glass" onPointerDown={start} onPointerUp={stop} onPointerLeave={stop}>
        🔒 Hold to unlock<i style={{ width: `${Math.min(100, hold * 100)}%` }} />
      </button>
    </div>
  );
}
