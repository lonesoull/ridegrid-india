import { engine, type Leg } from '../core/engine';
import { haversine, type LngLat } from '../core/geo';

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const f6 = (n: number) => n.toFixed(6);

export function download(name: string, data: BlobPart | Blob, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export const safeName = (s: string) => s.replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 60) || 'route';
const stamp = () => new Date().toISOString().replace(/[:]/g, '').slice(0, 15);

/** Ordered legs following stop order (road geometry when routed, flagged otherwise). */
function orderedLegs() {
  const S = engine.stops;
  const out: { coords: LngLat[]; routed: boolean; distM: number }[] = [];
  const byPair = new Map<string, Leg>();
  for (const l of engine.legs.values()) byPair.set(`${l.a}>${l.b}`, l);
  for (let i = 0; i < S.length - 1; i++) {
    const l = byPair.get(`${S[i].id}>${S[i + 1].id}`);
    const from: LngLat = [S[i].lng, S[i].lat], to: LngLat = [S[i + 1].lng, S[i + 1].lat];
    if (l?.status === 'ok' && l.coords) out.push({ coords: l.coords, routed: true, distM: l.distM });
    else out.push({ coords: [from, to], routed: false, distM: haversine(from, to) });
  }
  return out;
}

/** GPX 1.1: waypoints (numbered stops) + rte (stop sequence) + trk (full road geometry). */
export function toGPX(tripName: string): string {
  const now = new Date().toISOString();
  const S = engine.stops;
  const p: string[] = [];
  p.push(`<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RideGrid India" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">`);
  p.push(`<metadata><name>${esc(tripName)}</name><desc>${S.length} stops, planned route exported ${now}</desc><time>${now}</time></metadata>`);
  S.forEach((s, i) => p.push(`<wpt lat="${f6(s.lat)}" lon="${f6(s.lng)}"><time>${now}</time><name>${i + 1}${s.name ? ' ' + esc(s.name) : ''}</name><sym>Waypoint</sym></wpt>`));
  p.push(`<rte><name>${esc(tripName)} — stop order</name>`);
  S.forEach((s, i) => p.push(`<rtept lat="${f6(s.lat)}" lon="${f6(s.lng)}"><name>${i + 1}</name></rtept>`));
  p.push('</rte>');
  p.push(`<trk><name>${esc(tripName)} — road geometry</name><trkseg>`);
  let last: LngLat | null = null;
  for (const l of orderedLegs()) {
    for (const c of l.coords) {
      if (last && last[0] === c[0] && last[1] === c[1]) continue;
      p.push(`<trkpt lat="${f6(c[1])}" lon="${f6(c[0])}"/>`);
      last = c;
    }
  }
  p.push('</trkseg></trk></gpx>');
  return p.join('\n');
}

/** Styled KML with folders: Stops, Planned route (road), Unrouted legs. */
export function toKML(tripName: string): string {
  const S = engine.stops;
  const legs = orderedLegs();
  const coords = (c: LngLat[]) => c.map((x) => `${f6(x[0])},${f6(x[1])},0`).join(' ');
  const p: string[] = [];
  p.push(`<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(tripName)}</name>`);
  p.push('<Style id="route"><LineStyle><color>ffff901e</color><width>5</width></LineStyle></Style>');
  p.push('<Style id="unrouted"><LineStyle><color>ff8b7464</color><width>2</width></LineStyle></Style>');
  p.push('<Style id="stop"><IconStyle><color>ffff901e</color><scale>0.8</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>');
  p.push('<Style id="start"><IconStyle><color>ff5ec522</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>');
  p.push('<Style id="end"><IconStyle><color>ff4444ef</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle></Style>');
  p.push('<Folder><name>Stops</name>');
  S.forEach((s, i) => p.push(`<Placemark><name>${i + 1}${s.name ? ' ' + esc(s.name) : ''}</name><styleUrl>#${i === 0 ? 'start' : i === S.length - 1 ? 'end' : 'stop'}</styleUrl><Point><coordinates>${f6(s.lng)},${f6(s.lat)},0</coordinates></Point></Placemark>`));
  p.push('</Folder><Folder><name>Planned route (road)</name>');
  // group consecutive routed legs into one LineString each (keeps files small)
  let run: LngLat[] = [];
  const flush = () => { if (run.length > 1) p.push(`<Placemark><styleUrl>#route</styleUrl><LineString><tessellate>1</tessellate><coordinates>${coords(run)}</coordinates></LineString></Placemark>`); run = []; };
  for (const l of legs) { if (l.routed) run.push(...(run.length ? l.coords.slice(1) : l.coords)); else flush(); }
  flush();
  p.push('</Folder><Folder><name>Unrouted legs</name>');
  legs.forEach((l, i) => { if (!l.routed) p.push(`<Placemark><name>${i + 1}→${i + 2}</name><styleUrl>#unrouted</styleUrl><LineString><coordinates>${coords(l.coords)}</coordinates></LineString></Placemark>`); });
  p.push('</Folder></Document></kml>');
  return p.join('\n');
}

/** CSV logbook: stop #, name, lat, lng, leg km, cumulative km, routed flag. */
export function toCSV(): string {
  const S = engine.stops;
  const legs = orderedLegs();
  const rows = ['stop_no,name,lat,lng,leg_km,cumulative_km,leg_road_routed'];
  let cum = 0;
  S.forEach((s, i) => {
    const l = i > 0 ? legs[i - 1] : null;
    if (l) cum += l.distM;
    const name = s.name ? `"${s.name.replace(/"/g, '""')}"` : '';
    rows.push(`${i + 1},${name},${f6(s.lat)},${f6(s.lng)},${l ? (l.distM / 1000).toFixed(3) : '0.000'},${(cum / 1000).toFixed(3)},${l ? (l.routed ? 'yes' : 'no') : ''}`);
  });
  return rows.join('\n');
}

export function exportAs(kind: 'gpx' | 'kml' | 'csv', tripName: string) {
  const base = `${safeName(tripName)}_${stamp()}`;
  if (kind === 'gpx') download(`${base}.gpx`, toGPX(tripName), 'application/gpx+xml');
  if (kind === 'kml') download(`${base}.kml`, toKML(tripName), 'application/vnd.google-earth.kml+xml');
  if (kind === 'csv') download(`${base}.csv`, toCSV(), 'text/csv');
}
