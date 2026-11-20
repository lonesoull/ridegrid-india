/**
 * Coordinate input (OsmAnd "Search → coordinates"): decimal lat/lon, degrees-minutes-seconds,
 * Open Location Codes (plus codes, full form), UTM. Returns [lng, lat] or null.
 */
export type LngLat = [number, number];

export function parseCoords(input: string): LngLat | null {
  const s = input.trim();
  return plusCode(s) ?? utm(s) ?? dms(s) ?? decimal(s);
}

function decimal(s: string): LngLat | null {
  const m = /^(-?\d{1,2}(?:\.\d+)?)\s*([NS])?\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*([EW])?$/i.exec(s);
  if (!m) return null;
  let lat = +m[1], lng = +m[3];
  if (m[2]?.toUpperCase() === 'S') lat = -Math.abs(lat);
  if (m[4]?.toUpperCase() === 'W') lng = -Math.abs(lng);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lng, lat] : null;
}

function dms(s: string): LngLat | null {
  const part = String.raw`(\d{1,3})[°\s]\s*(\d{1,2})?['′\s]?\s*(\d{1,2}(?:\.\d+)?)?["″]?\s*([NSEW])`;
  const m = new RegExp(`^${part}[,\\s]+${part}$`, 'i').exec(s);
  if (!m) return null;
  const v = (d: string, mi?: string, se?: string, h?: string) => { const x = +d + (+(mi ?? 0)) / 60 + (+(se ?? 0)) / 3600; return /[SW]/i.test(h ?? '') ? -x : x; };
  const a = v(m[1], m[2], m[3], m[4]), b = v(m[5], m[6], m[7], m[8]);
  return /[NS]/i.test(m[4]) ? [b, a] : [a, b];
}

const OLC = '23456789CFGHJMPQRVWX';
function plusCode(s: string): LngLat | null {
  const code = s.toUpperCase().replace(/\s+/g, '');
  if (!/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{0,3}$/.test(code)) return null;
  const c = code.replace('+', '');
  let lat = -90, lng = -180, res = 20;
  for (let i = 0; i < Math.min(c.length, 10); i += 2) {
    lat += OLC.indexOf(c[i]) * res; lng += OLC.indexOf(c[i + 1] ?? '2') * res;
    if (i < 8) res /= 20;
  }
  let latRes = res, lngRes = res;
  if (c.length <= 10) { latRes = res; lngRes = res; }
  if (c.length > 10) {
    latRes = 0.000125; lngRes = 0.000125;
    for (let i = 10; i < c.length; i++) { const d = OLC.indexOf(c[i]); latRes /= 5; lngRes /= 4; lat += Math.floor(d / 4) * latRes; lng += (d % 4) * lngRes; }
  }
  return [lng + lngRes / 2, lat + latRes / 2];
}

function utm(s: string): LngLat | null {
  const m = /^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d{5,7}(?:\.\d+)?)\s*m?E?\s+(\d{6,8}(?:\.\d+)?)\s*m?N?$/i.exec(s);
  if (!m) return null;
  const zone = +m[1], north = m[2].toUpperCase() >= 'N', E = +m[3], N = +m[4];
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const x = E - 500000, y = north ? N : N - 10000000;
  const M = y / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2), T1 = Math.tan(p1) ** 2, C1 = ep2 * Math.cos(p1) ** 2;
  const R1 = a * (1 - e2) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5, D = x / (N1 * k0);
  const lat = p1 - (N1 * Math.tan(p1) / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lng = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / Math.cos(p1);
  return [((zone - 1) * 6 - 180 + 3) + lng * 180 / Math.PI, lat * 180 / Math.PI];
}

/** Find coordinates in a shared text: geo: URIs, Google Maps / WhatsApp links, plain "lat, lng". */
export function locationFromText(t: string): [number, number] | null {
  const s = decodeURIComponent(t);
  const pats = [/geo:(-?\d+\.\d+),(-?\d+\.\d+)/, /[@?&](?:q|query|ll|destination|daddr|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/];
  for (const re of pats) { const m = re.exec(s); if (m) return [+m[2], +m[1]]; }
  return parseCoords(s.trim());
}

// ---------------------------------------------------------------- output formats (OsmAnd coordinate formats)
export type CoordFormat = 'dec' | 'dms' | 'utm' | 'olc';
export function formatCoords(p: LngLat, f: CoordFormat): string {
  const [lng, lat] = p;
  if (f === 'dms') {
    const d = (v: number, pos: string, neg: string) => { const a = Math.abs(v), D = Math.floor(a), M = Math.floor((a - D) * 60), S = ((a - D) * 60 - M) * 60; return `${D}°${String(M).padStart(2, '0')}'${S.toFixed(1).padStart(4, '0')}"${v >= 0 ? pos : neg}`; };
    return `${d(lat, 'N', 'S')} ${d(lng, 'E', 'W')}`;
  }
  if (f === 'utm') return toUtm(lat, lng);
  if (f === 'olc') return toPlusCode(lat, lng);
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}
function toUtm(lat: number, lon: number): string {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e2 = f * (2 - f), ep2 = e2 / (1 - e2), R = Math.PI / 180;
  const zone = Math.floor((lon + 180) / 6) + 1, lon0 = (zone - 1) * 6 - 180 + 3;
  const phi = lat * R, lam = (lon - lon0) * R;
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2), T = Math.tan(phi) ** 2, C = ep2 * Math.cos(phi) ** 2, A = Math.cos(phi) * lam;
  const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * phi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * phi) + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * phi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * phi));
  const E = k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;
  let Nn = k0 * (M + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) Nn += 10000000;
  const band = 'CDEFGHJKLMNPQRSTUVWXX'[Math.floor((lat + 80) / 8)] ?? 'X';
  return `${zone}${band} ${Math.round(E)} ${Math.round(Nn)}`;
}
function toPlusCode(lat: number, lng: number): string {
  let la = Math.min(89.9999999, lat) + 90, lo = (((lng + 180) % 360) + 360) % 360;
  let code = '', res = 20;
  for (let i = 0; i < 5; i++) {
    const a = Math.floor(la / res), b = Math.floor(lo / res);
    la -= a * res; lo -= b * res; code += OLC[a] + OLC[b]; if (i < 4) res /= 20;
  }
  return `${code.slice(0, 8)}+${code.slice(8)}`;
}
