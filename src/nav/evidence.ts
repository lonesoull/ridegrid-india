import { db } from '../core/db';
import type { LngLat } from '../core/geo';
import { engine } from '../core/engine';
import { isExpedition } from '../core/terms';
import { logStop, placeName, dayKey } from './logbook';
import { nav } from './navigator';
import { say, sounds } from './audio';

/**
 * Hourly evidence: photos/videos taken in the app get GPS, time and place recorded in the logbook,
 * and every photo is saved twice — the untouched original (with its camera EXIF) and a copy with
 * the date, time, coordinates and place printed on it (EXIF is often stripped when files are shared).
 */
export async function stampPhoto(file: Blob, lines: string[]): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const fs = Math.max(16, Math.round(w / 42)), pad = Math.round(fs * 0.6), lh = Math.round(fs * 1.3);
  const boxH = pad * 2 + lh * lines.length;
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(0, h - boxH, w, boxH);
  g.fillStyle = '#fff';
  g.font = `600 ${fs}px system-ui, sans-serif`;
  g.textBaseline = 'top';
  lines.forEach((t, i) => g.fillText(t, pad, h - boxH + pad + i * lh, w - 2 * pad));
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not save the stamped photo'))), 'image/jpeg', 0.9));
}

/** Save photos/videos as one "Evidence" logbook entry at the current GPS position. */
export async function saveEvidence(files: File[], pos: LngLat, acc?: number) {
  const at = Date.now();
  const place = await Promise.race([placeName(pos), new Promise<undefined>((r) => setTimeout(r, 2500))]).catch(() => undefined);
  const trip = engine.trip!;
  const lines = [
    `${new Date(at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Kolkata' })} IST · ${new Date(at).toISOString().slice(0, 19)}Z`,
    `GPS ${pos[1].toFixed(6)}, ${pos[0].toFixed(6)}${acc ? ` ±${Math.round(acc)} m` : ''}${nav.mode === 'live' ? ` · ${Math.round(nav.speedMps * 3.6)} km/h` : ''}`,
    ...(place ? [place.slice(0, 90)] : []),
    `${trip.name} · RideGrid India`,
  ];
  const blobs: Blob[] = [];
  for (const f of files) {
    blobs.push(f);
    if (f.type.startsWith('image/')) { try { blobs.push(await stampPhoto(f, lines)); } catch { /* keep the original only */ } }
  }
  const s = await logStop({ tripId: trip.id, rideId: nav.ride?.id, type: 'evidence', at, lng: pos[0], lat: pos[1], acc, photos: blobs, place });
  reminder.lastAt = at; reminder.due = false; reminder.emit();
  return s;
}

/** While riding an expedition: "evidence photo due" every N minutes since the last one. */
export const reminder = {
  lastAt: 0,
  due: false,
  saidAt: 0,
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  timer: 0 as unknown as ReturnType<typeof setInterval>,
  async start() {
    const t = engine.trip;
    if (t) {
      const today = dayKey(Date.now());
      const last = await db.stopLogs.where('tripId').equals(t.id).filter((s) => s.type === 'evidence' && dayKey(s.at) === today).last();
      this.lastAt = last?.at ?? 0;
    }
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 30000);
  },
  tick() {
    const mins = nav.settings.evidenceMin;
    if (!mins || nav.mode !== 'live' || !isExpedition() || !nav.ride) { if (this.due) { this.due = false; this.emit(); } return; }
    const since = Math.max(this.lastAt, nav.ride.startedAt);
    const due = Date.now() - since >= mins * 60000;
    if (due !== this.due) { this.due = due; this.emit(); }
    if (due && Date.now() - this.saidAt > 20 * 60000) {
      this.saidAt = Date.now();
      sounds.arrival();
      if (nav.settings.voice) say('Evidence photo due. Take it at your next safe stop.');
    }
  },
};
