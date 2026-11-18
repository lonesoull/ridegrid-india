import JSZip from 'jszip';
import { db, uid, type StopLog, type StopType } from '../core/db';
import { haversine, type LngLat } from '../core/geo';
import { loadStates, stateAt } from './states';

export const STOP_LABEL: Record<StopType, string> = {
  start: 'Journey START', finish: 'Journey FINISH', document: 'Bike / rider document',
  daystart: 'Start of day', dayend: 'End of day',
  overnight: 'Overnight halt', police: 'Police signature', witness: 'Witness statement',
  fuel: 'Fuel bill', service: 'Service / repair bill', food: 'Food bill',
  evidence: 'Evidence photo / video', media: 'Media article', other: 'Other stop', break: 'Break',
};

/** Current Guinness record: longest journey by motorcycle in a single country (India, 2022–23). */
export const RECORD_KM = 140094.1;

/** Witness-type entries (a signature or statement from someone else). */
export const isWitnessEntry = (s: StopLog) => s.type === 'witness' || s.type === 'police';

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
export interface TrackGap { from: number; to: number; km: number }
export interface DaySummary {
  date: string; dayNo: number; km: number; firstAt: number; lastAt: number; movingMin: number;
  breaks: number; breakMin: number; stops: StopLog[];
  start?: StopLog; end?: StopLog; entries: StopLog[];
  /** GPS km inside India / outside (or on an unclear border) */
  kmIndia: number; kmOutside: number;
  /** stretches with no GPS recording (phone off, app closed, no signal) — not counted */
  gaps: TrackGap[];
  firstPos?: LngLat; lastPos?: LngLat;
  /** distance between where the previous day ended and where this day started */
  startGapKm?: number;
  witnesses: number; evidence: number;
  /** things an examiner would question */
  issues: string[];
}
export const dayKey = (t: number) => new Date(t).toLocaleDateString('en-CA'); // YYYY-MM-DD local

/** How strict the daily checks are (old Guinness journey rules asked for two witness signatures a day). */
export interface EvidenceRules { witnessesPerDay: number; /** record checks (expedition); off = plain ride diary */ record?: boolean }
export const DEFAULT_RULES: EvidenceRules = { witnessesPerDay: 1, record: true };

export async function daySummaries(tripId: string, rules: EvidenceRules = DEFAULT_RULES): Promise<DaySummary[]> {
  const statesOk = await loadStates();
  const days = new Map<string, DaySummary>();
  const get = (t: number) => {
    const k = dayKey(t);
    let d = days.get(k);
    if (!d) days.set(k, (d = { date: k, dayNo: 0, km: 0, firstAt: t, lastAt: t, movingMin: 0, breaks: 0, breakMin: 0, stops: [], entries: [], kmIndia: 0, kmOutside: 0, gaps: [], witnesses: 0, evidence: 0, issues: [] }));
    d.firstAt = Math.min(d.firstAt, t); d.lastAt = Math.max(d.lastAt, t);
    return d;
  };
  // country check, re-done only every ~500 m (state polygons are coarse anyway)
  let chkAt: LngLat | null = null, chkIn = true;
  const inCountry = (p: LngLat) => {
    if (!statesOk) return true;
    if (!chkAt || haversine(chkAt, p) > 500) { chkAt = p; chkIn = stateAt(p) !== null; }
    return chkIn;
  };
  const rides = (await db.rides.where('tripId').equals(tripId).filter((r) => !r.simulated).toArray()).sort((a, b) => a.startedAt - b.startedAt);
  let prev: [number, number, number, number, number] | null = null;
  for (const r of rides) {
    const chunks = await db.rideChunks.where('rideId').equals(r.id).sortBy('id');
    for (const c of chunks) for (const pt of c.pts) {
      if (pt[3] > 50) continue;
      const d = get(pt[0]);
      const p: LngLat = [pt[1], pt[2]];
      d.firstPos ??= p; d.lastPos = p;
      if (prev) {
        const m = haversine([prev[1], prev[2]], p);
        const dt = (pt[0] - prev[0]) / 1000;
        if (m > 1000 && dt > 300) d.gaps.push({ from: prev[0], to: pt[0], km: m / 1000 }); // moved without recording
        else if (dt > 0 && m / dt < 70) {
          d.km += m / 1000;
          if (inCountry(p)) d.kmIndia += m / 1000; else d.kmOutside += m / 1000;
          if (m / dt > 1.5 && dt < 120) d.movingMin += dt / 60;
        }
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
    if (isWitnessEntry(s)) d.witnesses++;
    if (s.type === 'evidence') d.evidence++;
  }
  const sorted = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  sorted.forEach((d, i) => {
    d.dayNo = i + 1;
    d.entries.sort((a, b) => a.at - b.at);
    const startPos: LngLat | undefined = d.start ? [d.start.lng, d.start.lat] : d.firstPos;
    const prevDay = sorted[i - 1];
    const prevEnd: LngLat | undefined = prevDay ? (prevDay.end ? [prevDay.end.lng, prevDay.end.lat] : prevDay.lastPos) : undefined;
    if (startPos && prevEnd) d.startGapKm = haversine(prevEnd, startPos) / 1000;
    // examiner's checklist (expedition / record trips only)
    if (rules.record === false) return;
    if (d.km > 1) {
      if (!d.start) d.issues.push('No "Start of day" entry (odometer + photo)');
      if (!d.end) d.issues.push('No "End of day" entry (odometer + photo)');
      if (d.witnesses < rules.witnessesPerDay) d.issues.push(d.witnesses ? `Only ${d.witnesses} of ${rules.witnessesPerDay} witness signatures today` : 'No witness signature / statement today');
      const hours = Math.floor(d.movingMin / 60);
      if (hours >= 1 && d.evidence < hours) d.issues.push(`Only ${d.evidence} evidence photo/video for ${hours} h of riding (aim: one every hour)`);
      if (d.start && d.start.odoKm === undefined) d.issues.push('Start-of-day odometer missing');
      if (d.end && d.end.odoKm === undefined) d.issues.push('End-of-day odometer missing');
      if (d.start && !d.start.photos?.length) d.issues.push('No photo with the start-of-day entry (odometer, bike with number plate)');
      if (d.end && !d.end.photos?.length) d.issues.push('No photo with the end-of-day entry (odometer)');
      for (const x of d.stops) if (['police', 'witness'].includes(x.type) && !x.photos?.length) d.issues.push(`${STOP_LABEL[x.type]} at ${new Date(x.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} has no photo of the signed page`);
      for (const x of d.stops) if (['police', 'witness'].includes(x.type) && x.witness && !x.witness.independent) d.issues.push(`Witness ${x.witness.name} is not marked independent`);
    }
    for (const x of d.entries) if ((x.type === 'start' || x.type === 'finish') && d.witnesses < 2)
      d.issues.push(`${STOP_LABEL[x.type]} needs two independent witnesses present and signing (${d.witnesses} logged today)`);
    if (d.startGapKm !== undefined && d.startGapKm > 1) d.issues.push(`Day started ${d.startGapKm.toFixed(1)} km from where the previous day ended — the journey must be continuous`);
    for (const g of d.gaps) d.issues.push(`GPS not recording ${new Date(g.from).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}–${new Date(g.to).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} while moving ${g.km.toFixed(1)} km (not counted)`);
    if (d.kmOutside > 0.5) d.issues.push(`${d.kmOutside.toFixed(1)} km outside India or on an unclear border — only km inside the country count`);
  });
  return sorted.reverse();
}

/** Whole-journey checks (not tied to one day). */
export function journeyIssues(days: DaySummary[]): string[] {
  const all = days.flatMap((d) => d.entries);
  const out: string[] = [];
  if (days.some((d) => d.km > 1) && !all.some((x) => x.type === 'start')) out.push('No "Journey START" entry (with two witnesses at the start point)');
  if (!all.some((x) => x.type === 'document')) out.push('No bike / rider documents logged: RC, purchase invoice and a brochure or maker\'s web page showing the model is commercially available; driving licence; insurance');
  return out;
}

/** Total GPS km inside India across all days (what the record counts). */
export const totalIndiaKm = (days: DaySummary[]) => days.reduce((a, d) => a + d.kmIndia, 0);

// ---------------------------------------------------------------- evidence pack
const csvq = (v: unknown) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const iso = (t?: number) => (t ? new Date(t).toISOString() : '');

const esc = (x: string) => x.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const ext = (b: Blob) => (b.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('quicktime', 'mov').split(';')[0];

/** Every real GPS point of one day (all rides), in time order. */
async function dayPoints(tripId: string, date: string) {
  const t0 = new Date(date + 'T00:00').getTime(), t1 = t0 + 86400000;
  const rides = (await db.rides.where('tripId').equals(tripId).filter((r) => !r.simulated && r.startedAt < t1 && (r.endedAt ?? Date.now()) >= t0).toArray()).sort((a, b) => a.startedAt - b.startedAt);
  const out: [number, number, number, number, number][] = [];
  for (const r of rides) for (const c of await db.rideChunks.where('rideId').equals(r.id).sortBy('id')) for (const pt of c.pts) if (pt[0] >= t0 && pt[0] < t1) out.push(pt);
  return out;
}

/** One timestamped GPX file per day (every point carries its UTC time). */
async function dayGPX(tripId: string, tripName: string, d: DaySummary) {
  const pts = await dayPoints(tripId, d.date);
  const p = [`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RideGrid India" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<metadata><name>${esc(tripName)} – Day ${d.dayNo} (${d.date})</name><desc>${d.kmIndia.toFixed(2)} km GPS inside India, ${pts.length} points</desc><time>${new Date(d.firstAt).toISOString()}</time></metadata>`,
    `<trk><name>Day ${d.dayNo} ${d.date}</name><type>motorcycle</type><trkseg>`];
  for (const [t, lng, lat, acc, spd] of pts) p.push(`<trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}"><time>${new Date(t).toISOString()}</time><desc>acc=${acc}m speed=${(spd * 3.6).toFixed(1)}km/h</desc></trkpt>`);
  p.push('</trkseg></trk></gpx>');
  return { gpx: p.join('\n'), pts };
}

/**
 * ZIP for the examiner: logbook, witnesses, bills, media, checks, one GPX per day, a KML of the
 * whole journey and every photo/video. `date` limits it to one day (small enough for a daily backup).
 */
export interface RiderInfo { riderName?: string; bikeReg?: string; bikeModel?: string }
export async function evidencePack(tripId: string, tripName: string, date?: string, rules: EvidenceRules = DEFAULT_RULES, rider: RiderInfo = {}): Promise<Blob> {
  const zip = new JSZip();
  const all = await daySummaries(tripId, rules);
  const days = (date ? all.filter((d) => d.date === date) : all).slice().sort((a, b) => a.date.localeCompare(b.date));
  const stops = (await listStopLogs(tripId)).filter((s) => !date || dayKey(s.at) === date);
  const rows = ['type,auto,start_utc,end_utc,duration_min,place,lat,lng,gps_accuracy_m,odometer_km,witness,note,link,files'];
  const wit = ['date_local,time_local,place,lat,lng,name,role_designation,office_organisation,phone,gazetted_officer,independent,files'];
  const media = ['date_local,title_note,link'];
  const files = zip.folder('photos_videos')!;
  for (const s of stops) {
    const names: string[] = [];
    (s.photos ?? []).forEach((b, i) => {
      const name = `${dayKey(s.at)}/${iso(s.at).slice(0, 19).replace(/[:T]/g, '-')}_${s.type}_${i + 1}.${ext(b)}`;
      files.file(name, b); names.push(name);
    });
    const w = s.witness;
    rows.push([STOP_LABEL[s.type], s.auto ? 'yes' : '', iso(s.at), iso(s.endAt), s.endAt ? ((s.endAt - s.at) / 60000).toFixed(1) : '', s.place ?? '',
      s.lat.toFixed(7), s.lng.toFixed(7), s.acc ? Math.round(s.acc) : '', s.odoKm ?? '', w ? `${w.name}${w.role ? ' (' + w.role + ')' : ''}` : '', s.note ?? '', s.link ?? '', names.join(' ')].map(csvq).join(','));
    if (isWitnessEntry(s)) wit.push([dayKey(s.at), new Date(s.at).toLocaleTimeString('en-IN'), s.place ?? '', s.lat.toFixed(7), s.lng.toFixed(7), w?.name ?? '', w?.role ?? '', w?.org ?? '', w?.phone ?? '', w?.gazetted ? 'yes' : '', w?.independent ? 'yes' : '', names.join(' ')].map(csvq).join(','));
    if (s.type === 'media') media.push([dayKey(s.at), s.note ?? '', s.link ?? ''].map(csvq).join(','));
  }
  zip.file('logbook.csv', rows.join('\n'));
  zip.file('witnesses.csv', wit.join('\n'));
  if (media.length > 1) zip.file('media.csv', media.join('\n'));
  zip.file('daily_summary.csv', ['day,date,km_gps_india,km_outside_or_unclear,km_odometer,first_fix_local,last_fix_local,moving_min,breaks,break_min,witnesses,evidence_photos,start_gap_km,gps_gaps,stops']
    .concat(days.map((d) => [d.dayNo, d.date, d.kmIndia.toFixed(3), d.kmOutside.toFixed(3),
      d.start?.odoKm !== undefined && d.end?.odoKm !== undefined ? (d.end.odoKm - d.start.odoKm).toFixed(1) : '',
      new Date(d.firstAt).toLocaleTimeString('en-IN'), new Date(d.lastAt).toLocaleTimeString('en-IN'),
      Math.round(d.movingMin), d.breaks, Math.round(d.breakMin), d.witnesses, d.evidence, d.startGapKm?.toFixed(2) ?? '', d.gaps.length,
      d.stops.map((s) => STOP_LABEL[s.type]).join(' | ')].map(csvq).join(','))).join('\n'));
  zip.file('checks.csv', ['day,date,issue'].concat(date ? [] : journeyIssues(all).map((x) => ['journey', '', x].map(csvq).join(','))).concat(days.flatMap((d) => d.issues.map((x) => [d.dayNo, d.date, x].map(csvq).join(',')))).join('\n'));
  const gpx = zip.folder('gps_tracks')!;
  const kml: string[] = [];
  for (const d of days) {
    const { gpx: g, pts } = await dayGPX(tripId, tripName, d);
    gpx.file(`day-${String(d.dayNo).padStart(3, '0')}_${d.date}.gpx`, g);
    // KML line for the day, thinned to ~50 m (the GPX keeps every point)
    const line: string[] = []; let last: LngLat | null = null;
    for (const pt of pts) { const p: LngLat = [pt[1], pt[2]]; if (!last || haversine(last, p) >= 50) { line.push(`${p[0].toFixed(6)},${p[1].toFixed(6)}`); last = p; } }
    if (line.length > 1) kml.push(`<Placemark><name>Day ${d.dayNo} · ${d.date} · ${d.kmIndia.toFixed(1)} km</name><styleUrl>#ride</styleUrl><LineString><tessellate>1</tessellate><coordinates>${line.join(' ')}</coordinates></LineString></Placemark>`);
  }
  for (const s of stops) if (s.type !== 'break') kml.push(`<Placemark><name>${esc(STOP_LABEL[s.type])}${s.witness ? ' – ' + esc(s.witness.name) : ''}</name><description>${esc(new Date(s.at).toLocaleString('en-IN'))} ${esc(s.place ?? '')}</description><Point><coordinates>${s.lng.toFixed(6)},${s.lat.toFixed(6)}</coordinates></Point></Placemark>`);
  zip.file('journey.kml', `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(tripName)}</name><Style id="ride"><LineStyle><color>ff0055ff</color><width>3</width></LineStyle></Style>${kml.join('')}</Document></kml>`);
  const total = totalIndiaKm(all);
  zip.file('README.txt', `Evidence pack for "${tripName}"${date ? ` — ${date} only` : ''}\nGenerated ${new Date().toISOString()} by RideGrid India.\nJourney so far: ${total.toFixed(1)} km by GPS inside India over ${all.length} day(s).\n` +
    `Rider: ${rider.riderName ?? '—'} · Motorcycle: ${rider.bikeModel ?? '—'} · Registration: ${rider.bikeReg ?? '—'} (same rider and motorcycle throughout).\n\n` +
    `logbook.csv – every entry (start/end of day, overnight, police signature, witness, bills, evidence photos, automatic breaks): UTC time, GPS position, odometer.\n` +
    `witnesses.csv – who signed or gave a statement, where and when (statements themselves are written and signed by the witnesses; photos in photos_videos/).\n` +
    `daily_summary.csv – km by GPS inside India per day, odometer km, riding time, breaks, witnesses, evidence photos, continuity.\n` +
    `checks.csv – anything an examiner may question (missing witness, GPS gaps, day not starting where the last ended…).\n` +
    `gps_tracks/ – one timestamped GPX 1.1 file per day. journey.kml – the whole journey and every logged stop for Google Earth.\n` +
    `photos_videos/<date>/ – odometer, bills, signed pages, hourly evidence (each evidence photo has the original file and a copy with GPS/time printed on it).\n`);
  return zip.generateAsync({ type: 'blob' });
}
