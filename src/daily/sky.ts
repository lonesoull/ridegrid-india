/**
 * Sky positions (OsmAnd astronomy plugin): sidereal time, RA/Dec → altitude/azimuth, Sun, Moon and
 * naked-eye planets from JPL's approximate Keplerian elements (good to well under a degree 1800–2050).
 */
const R = Math.PI / 180;
export const julian = (d: Date) => d.getTime() / 86400000 + 2440587.5;
/** Local sidereal time in degrees. */
export function lst(d: Date, lng: number) {
  const T = julian(d) - 2451545.0;
  return (((280.46061837 + 360.98564736629 * T + lng) % 360) + 360) % 360;
}
/** Equatorial (deg) → horizontal: altitude, azimuth (deg, from north clockwise). */
export function altAz(raDeg: number, decDeg: number, latDeg: number, lstDeg: number) {
  const H = (lstDeg - raDeg) * R, dec = decDeg * R, lat = latDeg * R;
  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
  const alt = Math.asin(sinAlt);
  const az = Math.atan2(-Math.cos(dec) * Math.sin(H), Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H));
  return { alt: alt / R, az: ((az / R) + 360) % 360 };
}

// a, e, I, L, varpi, Omega and their rates per Julian century (J2000)
const EL: Record<string, number[]> = {
  Mercury: [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593, 0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  Venus: [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255, 0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  Earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  Mars: [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  Jupiter: [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909, -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  Saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448, -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
};
function helio(name: string, T: number) {
  const e0 = EL[name];
  const [a, e, I, L, w, O] = e0.slice(0, 6).map((v, i) => v + e0[i + 6] * T);
  const M = (((L - w) % 360) + 540) % 360 - 180;
  let E = M * R + e * Math.sin(M * R);
  for (let k = 0; k < 6; k++) E -= (E - e * Math.sin(E) - M * R) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const om = (w - O) * R, Or = O * R, Ir = I * R;
  return {
    x: (Math.cos(om) * Math.cos(Or) - Math.sin(om) * Math.sin(Or) * Math.cos(Ir)) * xp + (-Math.sin(om) * Math.cos(Or) - Math.cos(om) * Math.sin(Or) * Math.cos(Ir)) * yp,
    y: (Math.cos(om) * Math.sin(Or) + Math.sin(om) * Math.cos(Or) * Math.cos(Ir)) * xp + (-Math.sin(om) * Math.sin(Or) + Math.cos(om) * Math.cos(Or) * Math.cos(Ir)) * yp,
    z: Math.sin(om) * Math.sin(Ir) * xp + Math.cos(om) * Math.sin(Ir) * yp,
  };
}
const OBL = 23.43928 * R;
const toRaDec = (x: number, y: number, z: number) => {
  const ye = y * Math.cos(OBL) - z * Math.sin(OBL), ze = y * Math.sin(OBL) + z * Math.cos(OBL);
  return { ra: ((Math.atan2(ye, x) / R) + 360) % 360, dec: Math.atan2(ze, Math.hypot(x, ye)) / R };
};

export interface Body { name: string; ra: number; dec: number; mag: number; color: string }
export function bodies(d: Date): Body[] {
  const T = (julian(d) - 2451545.0) / 36525;
  const E = helio('Earth', T);
  const out: Body[] = [];
  const sun = toRaDec(-E.x, -E.y, -E.z);
  out.push({ name: 'Sun', ...sun, mag: -26.7, color: '#ffd43b' });
  const MAG: Record<string, number> = { Mercury: 0, Venus: -4.2, Mars: 0.5, Jupiter: -2.2, Saturn: 0.6 };
  const COL: Record<string, string> = { Mercury: '#bbb', Venus: '#fff4c2', Mars: '#ff8a65', Jupiter: '#ffe0b2', Saturn: '#ffe082' };
  for (const n of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn']) { const p = helio(n, T); out.push({ name: n, ...toRaDec(p.x - E.x, p.y - E.y, p.z - E.z), mag: MAG[n], color: COL[n] }); }
  // Moon (low-precision series)
  const dd = julian(d) - 2451545.0;
  const Lm = 218.316 + 13.176396 * dd, Mm = 134.963 + 13.064993 * dd, F = 93.272 + 13.22935 * dd;
  const lon = (Lm + 6.289 * Math.sin(Mm * R)) * R, lat = 5.128 * Math.sin(F * R) * R;
  out.push({ name: 'Moon', ...toRaDec(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)), mag: -12, color: '#eee' });
  return out;
}
