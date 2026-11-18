import JSZip from 'jszip';
import { db, uid, type StopLog, type StopType } from '../core/db';
import { haversine, type LngLat } from '../core/geo';
import { rideGPX } from './rides';

export const STOP_LABEL: Record<StopType, string> = {
  daystart: 'Start of day', dayend: 'End of day',
  overnight: 'Overnight halt', police: 'Police signature', fuel: 'Fuel', other: 'Other stop', break: 'Break',
};

export async function logStop(p: Omit<StopLog, 'id'>): Promise<StopLog> {
  const s: StopLog = { ...p, id: uid() };
  await db.stopLogs.put(s);
  // fill in the place name in the background (works later too if offline now)
  void placeName([s.lng, s.lat]).then((place) => { if (place) void updateStopLog(s.id, { place }); });
  return s;
}

/** Reverse geocode with OpenStreetMap Nominatim (free, ~1 request/sec). */
let lastGeo = 0;
export async function placeName(p: LngLat): Promise<string | undefined> {
  try {
    const wait = 1100 - (Date.now() - lastGeo);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeo = Date.now();
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${p[1].toFixed(6)}&lon=${p[0].toFixed(6)}&zoom=16&accept-language=en`);
    if (!r.ok) return undefined;
    const j = await r.json();
    const a = j.address ?? {};
    const parts = [a.road, a.suburb ?? a.neighbourhood ?? a.village ?? a.hamlet, a.city ?? a.town ?? a.county ?? a.state_district, a.state].filter(Boolean);
    return [...new Set(parts)].join(', ') || j.display_name;
  } catch { return undefined; }
}

/** Fill place names for entries logged while offline. */
export async function fillMissingPlaces(tripId: string) {
  for (const s of await listStopLogs(tripId)) if (!s.place && s.type !== 'break') {
    const place = await placeName([s.lng, s.lat]);
    if (place) await updateStopLog(s.id, { place });
  }
}
export const updateStopLog = (id: string, patch: Partial<StopLog>) => db.stopLogs.update(id, patch);
export const deleteStopLog = (id: string) => db.stopLogs.delete(id);
export async function listStopLogs(tripId: string) {
  return (await db.stopLogs.where('tripId').equals(tripId).toArray()).sort((a, b) => a.at - b.at);
}

/**
 * Automatic break detection: stationary (< 30 m drift, slow) for `minMinutes` → a break is logged;
 * it ends when the rider moves > 50 m away.
 */
export class BreakDetector {
  private anchor: LngLat | null = null;
  private since = 0;
  current: StopLog | null = null;
  constructor(private getCtx: () => { tripId: string; rideId?: string; minMinutes: number }) {}

  async onFix(p: LngLat, t: number, speedMps: number, acc: number) {
    const ctx = this.getCtx();
    const d = this.anchor ? haversine(this.anchor, p) : Infinity;
    if (!this.anchor || (d > 50 && !this.current) || (this.current && d > 50)) {
      if (this.current) { await updateStopLog(this.current.id, { endAt: t }); this.current = null; }
      this.anchor = p; this.since = t;
      return;
    }
    if (d < 30 && speedMps < 2 && !this.current && t - this.since >= ctx.minMinutes * 60000) {
      this.current = await logStop({ tripId: ctx.tripId, rideId: ctx.rideId, type: 'break', auto: true, at: this.since, lng: this.anchor[0], lat: this.anchor[1], acc });
    }
  }
  async close(t = Date.now()) {
    if (this.current) await updateStopLog(this.current.id, { endAt: t });
    this.current = null; this.anchor = null;
  }
}

// ---------------------------------------------------------------- daily summary
export interface DaySummary {
  date: string; dayNo: number; km: number; firstAt: number; lastAt: number; movingMin: number;
  breaks: number; breakMin: number; stops: StopLog[];
  start?: StopLog; end?: StopLog; entries: StopLog[];
}
const dayKey = (t: number) => new Date(t).toLocaleDateString('en-CA'); // YYYY-MM-DD local

export async function daySummaries(tripId: string): Promise<DaySummary[]> {
  const days = new Map<string, DaySummary>();
  const get = (t: number) => {
    const k = dayKey(t);
    let d = days.get(k);
    if (!d) days.set(k, (d = { date: k, dayNo: 0, km: 0, firstAt: t, lastAt: t, movingMin: 0, breaks: 0, breakMin: 0, stops: [], entries: [] }));
    d.firstAt = Math.min(d.firstAt, t); d.lastAt = Math.max(d.lastAt, t);
    return d;
  };
  const rides = await db.rides.where('tripId').equals(tripId).filter((r) => !r.simulated).toArray();
  for (const r of rides) {
    const chunks = await db.rideChunks.where('rideId').equals(r.id).sortBy('id');
    let prev: [number, number, number, number, number] | null = null;
    for (const c of chunks) for (const pt of c.pts) {
      const d = get(pt[0]);
      if (prev && pt[3] <= 50 && prev[3] <= 50) {
        const m = haversine([prev[1], prev[2]], [pt[1], pt[2]]);
        const dt = (pt[0] - prev[0]) / 1000;
        if (dt > 0 && m / dt < 70) { d.km += m / 1000; if (m / dt > 1.5 && dt < 120) d.movingMin += dt / 60; }
      }
      prev = pt;
    }
  }
  for (const s of await listStopLogs(tripId)) {
    const d = get(s.at);
    d.entries.push(s);
    if (s.type === 'break') { d.breaks++; d.breakMin += ((s.endAt ?? s.at) - s.at) / 60000; }
    else if (s.type === 'daystart') d.start ??= s;
    else if (s.type === 'dayend') d.end = s;
    else d.stops.push(s);
  }
  const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  sorted.forEach((d, i) => { d.dayNo = i + 1; d.entries.sort((a, b) => a.at - b.at); });
  return sorted.reverse();
}

// ---------------------------------------------------------------- evidence pack
const csvq = (v: unknown) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const iso = (t?: number) => (t ? new Date(t).toISOString() : '');

/** ZIP: logbook.csv, daily_summary.csv, every ride as timestamped GPX, and every stop photo. */
export async function evidencePack(tripId: string, tripName: string): Promise<Blob> {
  const zip = new JSZip();
  const stops = await listStopLogs(tripId);
  const rows = ['type,auto,start_utc,end_utc,duration_min,place,lat,lng,gps_accuracy_m,odometer_km,note,photos'];
  const photos = zip.folder('photos')!;
  for (const s of stops) {
    const names: string[] = [];
    (s.photos ?? []).forEach((b, i) => {
      const ext = (b.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const name = `${iso(s.at).slice(0, 19).replace(/[:T]/g, '-')}_${s.type}_${i + 1}.${ext}`;
      photos.file(name, b); names.push(name);
    });
    rows.push([STOP_LABEL[s.type], s.auto ? 'yes' : '', iso(s.at), iso(s.endAt), s.endAt ? ((s.endAt - s.at) / 60000).toFixed(1) : '', s.place ?? '',
      s.lat.toFixed(7), s.lng.toFixed(7), s.acc ? Math.round(s.acc) : '', s.odoKm ?? '', s.note ?? '', names.join(' ')].map(csvq).join(','));
  }
  zip.file('logbook.csv', rows.join('\n'));
  const days = await daySummaries(tripId);
  zip.file('daily_summary.csv', ['date,km,first_fix_local,last_fix_local,moving_min,breaks,break_min,stops']
    .concat(days.map((d) => [d.date, d.km.toFixed(3), new Date(d.firstAt).toLocaleTimeString('en-IN'), new Date(d.lastAt).toLocaleTimeString('en-IN'),
      Math.round(d.movingMin), d.breaks, Math.round(d.breakMin), d.stops.map((s) => STOP_LABEL[s.type]).join(' | ')].map(csvq).join(','))).join('\n'));
  const gpx = zip.folder('gps_tracks')!;
  for (const r of await db.rides.where('tripId').equals(tripId).toArray()) {
    gpx.file(`${iso(r.startedAt).slice(0, 19).replace(/[:T]/g, '-')}${r.simulated ? '_SIMULATED' : ''}.gpx`, await rideGPX(r));
  }
  zip.file('README.txt', `Evidence pack for "${tripName}"\nGenerated ${new Date().toISOString()} by RideGrid India.\n\nlogbook.csv – every logged stop (overnight, police signature, fuel…) and automatic break, UTC times, GPS position, odometer.\ndaily_summary.csv – km, riding time and breaks per day (from real GPS rides only).\ngps_tracks/ – timestamped GPX 1.1 of every ride.\nphotos/ – odometer, receipt and signature photos named by UTC time and stop type.\n`);
  return zip.generateAsync({ type: 'blob' });
}
