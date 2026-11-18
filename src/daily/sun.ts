/** Sunrise / sunset (NOAA algorithm, ±1 min) in the device's local time. */
export function sunTimes(date: Date, lat: number, lng: number) {
  const rad = Math.PI / 180;
  const day = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / 86400000);
  const g = (2 * Math.PI / 365) * (day - 1);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(90.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) / (Math.cos(lat * rad) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return { rise: '—', set: '—', day: cosH > 1 ? '0 h' : '24 h', riseAt: null, setAt: null };
  const ha = Math.acos(cosH) / rad;
  const midnight = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const riseAt = new Date(midnight + (720 - 4 * (lng + ha) - eqt) * 60000);
  const setAt = new Date(midnight + (720 - 4 * (lng - ha) - eqt) * 60000);
  const fmt = (d: Date) => d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const mins = (setAt.getTime() - riseAt.getTime()) / 60000;
  return { rise: fmt(riseAt), set: fmt(setAt), day: `${Math.floor(mins / 60)} h ${Math.round(mins % 60)} min`, riseAt, setAt };
}
