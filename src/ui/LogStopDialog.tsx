import { useEffect, useState } from 'react';
import { engine } from '../core/engine';
import type { StopType, Witness } from '../core/db';
import { nav } from '../nav/navigator';
import { myLocation } from '../nav/directions';
import { logStop, STOP_LABEL, evidencePack, dayKey } from '../nav/logbook';
import { saveEvidence } from '../nav/evidence';
import { download, safeName } from '../io/exporters';
import { markBackup } from './LogbookTab';
import { ui, useUI, act, toast } from './state';
import { team } from '../team/team';

const TYPES: StopType[] = ['daystart', 'dayend', 'overnight', 'police', 'witness', 'fuel', 'service', 'food', 'evidence', 'media', 'other'];
const HINT: Partial<Record<StopType, string>> = {
  daystart: 'Photo of the odometer before you ride (and the witness/officer signature if your rules need one).',
  dayend: 'Photo of the odometer at the end of the day.',
  overnight: 'Photo of the odometer and the hotel/hostel bill or register.',
  police: 'Photo of the signed and stamped logbook page or letter, and the station board.',
  witness: 'The witness writes and signs their own statement (never pre-filled by you). Photograph the signed page and, if they agree, their ID or visiting card.',
  fuel: 'Photo of the GST fuel bill and the odometer.',
  service: 'Photo of the service / repair bill and the odometer.',
  food: 'Photo of the bill (Limca asks for food and fuel bills).',
  evidence: 'Photo or video of the bike (number plate visible) at this place. GPS, time and place are printed on a copy of each photo.',
  media: 'Newspaper / TV / online coverage of the journey: link and a photo or screenshot.',
};
const WITNESS: StopType[] = ['police', 'witness'];
const NO_ODO: StopType[] = ['media', 'food', 'evidence'];

/** Logbook entry: type, GPS position + time (automatic), odometer, witness details, photos/videos, note. */
export function LogStopDialog() {
  const open = useUI((s) => s.logStop);
  const [type, setType] = useState<StopType>('overnight');
  const [odo, setOdo] = useState('');
  const [note, setNote] = useState('');
  const [link, setLink] = useState('');
  const [w, setW] = useState<Witness>({ name: '' });
  const [photos, setPhotos] = useState<File[]>([]);
  useEffect(() => { if (typeof open === 'string') setType(open as StopType); }, [open]);
  if (!open) return null;
  const close = () => { ui.set({ logStop: false }); setOdo(''); setNote(''); setLink(''); setW({ name: '' }); setPhotos([]); };
  const isW = WITNESS.includes(type);
  const save = () => act('Saving entry…', async () => {
    if (isW && !w.name.trim()) throw new Error('Enter the witness / officer name');
    if (type === 'evidence' && !photos.length) throw new Error('Add at least one photo or video');
    let pos = nav.pos, acc = nav.accuracy;
    if (!pos) { pos = await myLocation(); acc = 0; }
    if (type === 'evidence') { await saveEvidence(photos, pos, acc); toast('Evidence saved with GPS, time and place'); close(); return; }
    await logStop({ tripId: engine.trip!.id, rideId: nav.ride?.id, type, at: Date.now(), lng: pos[0], lat: pos[1], acc,
      odoKm: odo ? +odo : undefined, note: note || undefined, photos, link: link || undefined, witness: isW ? { ...w, name: w.name.trim() } : undefined });
    if (team.settings) void team.send({ type: 'stop', from: team.settings.deviceId, name: team.settings.name, label: STOP_LABEL[type], pos, t: Date.now() });
    toast(`${STOP_LABEL[type]} logged with GPS, time${odo ? ', odometer' : ''}${photos.length ? ` and ${photos.length} file(s)` : ''} — see the Logbook tab`);
    const wasEnd = type === 'dayend';
    close();
    // back up the day's evidence off the phone straight away
    if (wasEnd && confirm("Day logged. Download today's evidence pack now and keep a copy on your laptop / Google Drive?")) {
      const t = engine.trip!, d = dayKey(Date.now());
      download(`${safeName(t.name)}_evidence_${d}.zip`, await evidencePack(t.id, t.name, d, { witnessesPerDay: nav.settings.witnessesPerDay }));
      markBackup(t.id, d);
    }
  });
  return (
    <div className="modal-wrap" onClick={close}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <h3>Logbook entry</h3>
        <div className="typegrid">
          {TYPES.map((t) => <button key={t} className={type === t ? 'on' : ''} onClick={() => setType(t)}>{STOP_LABEL[t]}</button>)}
        </div>
        <p className="muted">GPS position and exact time are recorded automatically. {HINT[type] ?? ''} {type !== 'media' && <b>Keep the bike's number plate visible in at least one photo.</b>}</p>
        {isW && <>
          <input placeholder="Name (as signed) *" value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} />
          <input placeholder="Designation (e.g. Sub-Inspector, Station House Officer)" value={w.role ?? ''} onChange={(e) => setW({ ...w, role: e.target.value })} />
          <input placeholder="Office / organisation (e.g. Hosur Town Police Station)" value={w.org ?? ''} onChange={(e) => setW({ ...w, org: e.target.value })} />
          <input type="tel" placeholder="Phone (for verification)" value={w.phone ?? ''} onChange={(e) => setW({ ...w, phone: e.target.value })} />
          <label className="check"><input type="checkbox" checked={!!w.gazetted} onChange={(e) => setW({ ...w, gazetted: e.target.checked })} /> Gazetted officer (Limca accepts their authentication)</label>
          <label className="check"><input type="checkbox" checked={!!w.independent} onChange={(e) => setW({ ...w, independent: e.target.checked })} /> Independent — not a relative, friend, team member or sponsor</label>
        </>}
        {type === 'media' && <input type="url" placeholder="Link to the article / video" value={link} onChange={(e) => setLink(e.target.value)} />}
        {!NO_ODO.includes(type) && <input type="number" inputMode="decimal" placeholder="Odometer reading (km)" value={odo} onChange={(e) => setOdo(e.target.value)} />}
        <label className="photo-btn">
          <input type="file" accept={type === 'evidence' || type === 'media' ? 'image/*,video/*' : 'image/*'} capture="environment" multiple hidden onChange={(e) => setPhotos([...photos, ...Array.from(e.target.files ?? [])])} />
          📷 Add {type === 'evidence' ? 'photo / video' : 'photo'}{photos.length ? ` (${photos.length} added)` : ''}
        </label>
        <textarea rows={2} placeholder={type === 'media' ? 'Title / newspaper' : 'Note (station name, hotel, what was signed…)'} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="btns">
          <button onClick={close}>Cancel</button>
          <button className="primary" onClick={save}>Save entry</button>
        </div>
      </div>
    </div>
  );
}
