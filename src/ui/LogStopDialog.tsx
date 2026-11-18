import { useEffect, useState } from 'react';
import { engine } from '../core/engine';
import type { StopType } from '../core/db';
import { nav } from '../nav/navigator';
import { myLocation } from '../nav/directions';
import { logStop, STOP_LABEL } from '../nav/logbook';
import { ui, useUI, act, toast } from './state';
import { team } from '../team/team';

const TYPES: StopType[] = ['daystart', 'dayend', 'overnight', 'police', 'fuel', 'other'];
const HINT: Partial<Record<StopType, string>> = {
  daystart: 'Photo of the odometer before you ride (and the witness/officer signature if your rules need one).',
  dayend: 'Photo of the odometer at the end of the day.',
  overnight: 'Photo of the odometer and the hotel/hostel bill or register.',
  police: 'Photo of the signed and stamped logbook page, and the officer/station board.',
  fuel: 'Photo of the GST fuel receipt and the odometer.',
};

/** Guinness-style stop log: type, GPS position + time (automatic), odometer, photos, note. */
export function LogStopDialog() {
  const open = useUI((s) => s.logStop);
  const [type, setType] = useState<StopType>('overnight');
  const [odo, setOdo] = useState('');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  useEffect(() => { if (typeof open === 'string') setType(open); }, [open]);
  if (!open) return null;
  const close = () => { ui.set({ logStop: false }); setOdo(''); setNote(''); setPhotos([]); };
  const save = () => act('Saving stop…', async () => {
    let pos = nav.pos, acc = nav.accuracy;
    if (!pos) { pos = await myLocation(); acc = 0; }
    await logStop({ tripId: engine.trip!.id, rideId: nav.ride?.id, type, at: Date.now(), lng: pos[0], lat: pos[1], acc, odoKm: odo ? +odo : undefined, note: note || undefined, photos });
    if (team.settings) void team.send({ type: 'stop', from: team.settings.deviceId, name: team.settings.name, label: STOP_LABEL[type], pos, t: Date.now() });
    toast(`${STOP_LABEL[type]} logged with GPS, time${odo ? ', odometer' : ''}${photos.length ? ` and ${photos.length} photo(s)` : ''} — see the Logbook tab`);
    close();
  });
  return (
    <div className="modal-wrap" onClick={close}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <h3>Logbook entry</h3>
        <div className="typegrid">
          {TYPES.map((t) => <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>{STOP_LABEL[t]}</button>)}
        </div>
        <p className="muted">GPS position and exact time are recorded automatically. {HINT[type] ?? ''} <b>Keep the bike's number plate visible in at least one photo.</b></p>
        <input type="number" inputMode="decimal" placeholder="Odometer reading (km)" value={odo} onChange={(e) => setOdo(e.target.value)} />
        <label className="photo-btn">
          <input type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => setPhotos([...photos, ...Array.from(e.target.files ?? [])])} />
          📷 Add photo{photos.length ? `s (${photos.length} added)` : ''}
        </label>
        <textarea rows={2} placeholder="Note (station name, officer, hotel…)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="btns">
          <button onClick={close}>Cancel</button>
          <button className="primary" onClick={save}>Save entry</button>
        </div>
      </div>
    </div>
  );
}
