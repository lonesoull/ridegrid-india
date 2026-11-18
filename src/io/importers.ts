import { gpx, kml, tcx } from '@tmcw/togeojson';
import { isValidLngLat, sampleLine, type LngLat } from '../core/geo';

export interface ImportedStop { p: LngLat; name?: string }
export interface ImportResult { file: string; stops: ImportedStop[]; note: string }
export interface ImportOptions { trackSampleM: number; prefer: 'auto' | 'points' | 'track' }

const xml = (text: string) => new DOMParser().parseFromString(text, 'text/xml');

/** Turn GeoJSON into ordered stops: explicit points win; otherwise tracks are sampled every N metres. */
export function fromGeoJSON(g: any, opt: ImportOptions): { stops: ImportedStop[]; note: string } {
  const feats: any[] = g?.type === 'FeatureCollection' ? g.features : g?.type === 'Feature' ? [g] : g?.type ? [{ type: 'Feature', properties: {}, geometry: g }] : [];
  const points: ImportedStop[] = [];
  const lines: LngLat[][] = [];
  const walk = (geom: any, name?: string) => {
    if (!geom) return;
    switch (geom.type) {
      case 'Point': points.push({ p: [geom.coordinates[0], geom.coordinates[1]], name }); break;
      case 'MultiPoint': geom.coordinates.forEach((c: number[]) => points.push({ p: [c[0], c[1]], name })); break;
      case 'LineString': lines.push(geom.coordinates.map((c: number[]) => [c[0], c[1]])); break;
      case 'MultiLineString': geom.coordinates.forEach((l: number[][]) => lines.push(l.map((c) => [c[0], c[1]]))); break;
      case 'Polygon': lines.push(geom.coordinates[0].map((c: number[]) => [c[0], c[1]])); break;
      case 'GeometryCollection': geom.geometries.forEach((x: any) => walk(x, name)); break;
    }
  };
  for (const f of feats) walk(f.geometry, f.properties?.name ?? f.properties?.title ?? f.properties?.desc);
  const useTrack = opt.prefer === 'track' || (opt.prefer === 'auto' && points.length < 2 && lines.length > 0);
  if (useTrack) {
    const stops = lines.flatMap((l) => sampleLine(l, opt.trackSampleM)).map((p) => ({ p }));
    return { stops: stops.filter((s) => isValidLngLat(...s.p)), note: `track sampled every ${opt.trackSampleM} m` };
  }
  return { stops: points.filter((s) => isValidLngLat(...s.p)), note: 'points' };
}

const LAT = /^(lat|latitude|y|lat_deg|stop_lat)$/i;
const LNG = /^(lng|lon|long|longitude|x|lon_deg|stop_lon)$/i;
const NAME = /^(name|title|stop|stop_name|label|place|description)$/i;

/** Rows from CSV/XLSX → stops, auto-detecting lat/lng/name columns (or first two numeric columns). */
export function fromRows(rows: any[][]): ImportedStop[] {
  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h ?? '').trim());
  let la = header.findIndex((h) => LAT.test(h));
  let lo = header.findIndex((h) => LNG.test(h));
  const nm = header.findIndex((h) => NAME.test(h));
  let body = rows.slice(1);
  if (la < 0 || lo < 0) {
    // headerless: find first two numeric columns, assume lat,lng (flip if it looks like lng,lat for India)
    body = rows;
    const r = rows.find((x) => x.filter((v) => Number.isFinite(parseFloat(v))).length >= 2) ?? [];
    const nums = r.map((v, i) => (Number.isFinite(parseFloat(v)) ? i : -1)).filter((i) => i >= 0);
    [la, lo] = [nums[0], nums[1]];
    if (la === undefined || lo === undefined) return [];
    const a = parseFloat(r[la]), b = parseFloat(r[lo]);
    if (Math.abs(a) > 60 && Math.abs(b) <= 60) [la, lo] = [lo, la];
  }
  const out: ImportedStop[] = [];
  for (const r of body) {
    const lat = parseFloat(r[la]), lng = parseFloat(r[lo]);
    if (!isValidLngLat(lng, lat)) continue;
    const name = nm >= 0 && r[nm] != null && String(r[nm]).trim() ? String(r[nm]).trim() : undefined;
    out.push({ p: [lng, lat], name });
  }
  return out;
}

/** Parse pasted text: one coordinate pair per line ("lat, lng" by default; "lng lat" if lngFirst). */
export function parseCoordinateText(text: string, lngFirst = false): ImportedStop[] {
  const out: ImportedStop[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)(?:[\s,;]+(.+))?/);
    if (!m) continue;
    let a = parseFloat(m[1]), b = parseFloat(m[2]);
    if (lngFirst) [a, b] = [b, a];
    if (!isValidLngLat(b, a)) continue;
    out.push({ p: [b, a], name: m[3]?.trim() || undefined });
  }
  return out;
}

async function parseCSV(text: string) {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(text, { type: 'string' });
  return XLSX.utils.sheet_to_json<any[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
}

async function parseFIT(buf: ArrayBuffer): Promise<ImportedStop[]> {
  const FitParser = (await import('fit-file-parser')).default as any;
  const parser = new FitParser({ force: true, mode: 'list', lengthUnit: 'm' });
  const data: any = await new Promise((res, rej) => parser.parse(buf, (err: any, d: any) => (err ? rej(err) : res(d))));
  const pts: LngLat[] = (data.records ?? [])
    .filter((r: any) => Number.isFinite(r.position_lat) && Number.isFinite(r.position_long))
    .map((r: any) => [r.position_long, r.position_lat]);
  return pts.map((p) => ({ p }));
}

export async function importFile(file: File, opt: ImportOptions): Promise<ImportResult> {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  const done = (r: { stops: ImportedStop[]; note: string }) => ({ file: file.name, ...r });
  switch (ext) {
    case 'gpx': return done(fromGeoJSON(gpx(xml(await file.text())), opt));
    case 'kml': return done(fromGeoJSON(kml(xml(await file.text())), opt));
    case 'tcx': return done(fromGeoJSON(tcx(xml(await file.text())), opt));
    case 'kmz': {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      const entry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith('.kml'));
      if (!entry) throw new Error(`${file.name}: no .kml inside`);
      return done(fromGeoJSON(kml(xml(await entry.async('string'))), opt));
    }
    case 'geojson': case 'json': return done(fromGeoJSON(JSON.parse(await file.text()), opt));
    case 'csv': case 'txt': return { file: file.name, stops: fromRows(await parseCSV(await file.text())), note: 'rows' };
    case 'xlsx': case 'xls': {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true });
      return { file: file.name, stops: fromRows(rows), note: 'rows' };
    }
    case 'fit': {
      const pts = await parseFIT(await file.arrayBuffer());
      const line = pts.map((s) => s.p);
      const sampled = opt.prefer === 'points' ? line : sampleLine(line, opt.trackSampleM);
      return { file: file.name, stops: sampled.map((p) => ({ p })), note: `FIT track sampled every ${opt.trackSampleM} m` };
    }
    default: throw new Error(`${file.name}: unsupported file type .${ext}`);
  }
}
