import { useState } from 'react';
import { google } from '../core/google';
import { nav } from '../nav/navigator';
import { ui } from '../ui/state';
import { dailyNav, type VoiceLang } from './dailyNav';
import { VOICE_LABEL } from './voice';
import { offlineMaps } from './offlineMap';
import { extras } from './extras';

const FLAG = 'ridegrid.daily.setupDone';
export const setupDone = () => { try { return localStorage.getItem(FLAG) === '1'; } catch { return true; } };
export const resetSetup = () => { try { localStorage.removeItem(FLAG); } catch { /* ignore */ } };

/** First-run Daily setup (OsmAnd "first start" wizard), in plain steps. Can be re-run from Tools. */
export function SetupWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [, tick] = useState(0);
  const finish = () => { try { localStorage.setItem(FLAG, '1'); } catch { /* ignore */ } onDone(); };
  const go = (tab: 'tools' | 'map') => { ui.set({ drawer: true, tab }); finish(); };
  const steps = [
    <>
      <h3>1 · Google map</h3>
      <p>The base map, search, traffic and routes come from Google — like Google Maps on your phone. It needs your own free Google key (instructions are in Tools).</p>
      <p>{google.settings.key ? '✅ Google key saved.' : '⬜ No Google key yet — the app still works with its own offline map.'}</p>
      {!google.settings.key && <button onClick={() => go('tools')}>Add Google key now</button>}
    </>,
    <>
      <h3>2 · Offline maps</h3>
      <p>Download your region so map, search and routes keep working with no signal (ghats, forests, borders).</p>
      <p>{offlineMaps.zones.length ? `✅ Downloaded: ${offlineMaps.zones.join(', ')}` : '⬜ Nothing downloaded yet.'}</p>
      {!offlineMaps.zones.length && <button onClick={() => go('map')}>Choose a region to download</button>}
    </>,
    <>
      <h3>3 · Voice</h3>
      <label className="field">Voice language
        <select value={dailyNav.s.voice} onChange={(e) => void dailyNav.save({ voice: e.target.value as VoiceLang }).then(() => tick((x) => x + 1))}>
          {Object.entries(VOICE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={nav.settings.voice} onChange={(e) => void nav.setSettings({ voice: e.target.checked }).then(() => tick((x) => x + 1))} /><span>Spoken instructions and alerts</span></label>
    </>,
    <>
      <h3>4 · Turn-by-turn in Google Maps</h3>
      <p>For turn arrows and lanes, RideGrid opens the Google Maps app with your next 10 stops. RideGrid keeps running behind it (track, alerts, logbook).</p>
      <label className="check"><input type="checkbox" checked={nav.settings.handoffAuto} onChange={(e) => void nav.setSettings({ handoffAuto: e.target.checked }).then(() => tick((x) => x + 1))} /><span>Open the next 10 automatically (off = I press a button)</span></label>
    </>,
    <>
      <h3>5 · While riding</h3>
      <label className="check"><input type="checkbox" checked={extras.s.notify} onChange={(e) => void extras.save({ notify: e.target.checked }).then(() => tick((x) => x + 1))} /><span>Next turn in the notification bar</span></label>
      <label className="check"><input type="checkbox" checked={extras.s.autoRecord} onChange={(e) => void extras.save({ autoRecord: e.target.checked }).then(() => tick((x) => x + 1))} /><span>Record my track automatically when I ride</span></label>
      <label className="check"><input type="checkbox" checked={extras.s.wakeScreen} onChange={(e) => void extras.save({ wakeScreen: e.target.checked }).then(() => tick((x) => x + 1))} /><span>Wake the screen before turns</span></label>
      <p className="muted">Everything else is in Ride, Map and Tools. You can run this setup again from Tools.</p>
    </>,
  ];
  return (
    <div className="sheet glass wizard" role="dialog" aria-label="Set up RideGrid">
      {steps[step]}
      <div className="btns">
        <button className="link muted" onClick={finish}>Skip</button>
        {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
        {step < steps.length - 1 ? <button className="primary" onClick={() => setStep(step + 1)}>Next</button> : <button className="primary" onClick={finish}>Done</button>}
      </div>
      <div className="muted" style={{ textAlign: 'center' }}>{step + 1} / {steps.length}</div>
    </div>
  );
}
