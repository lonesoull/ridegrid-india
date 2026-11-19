/**
 * OpenStreetMap opening_hours (the common subset OsmAnd's openingHoursParser handles for shops):
 *   "24/7", "Mo-Fr 09:00-18:00; Sa 10:00-14:00", "Mo-Su 06:00-22:00", "Mo-Sa 09:00-13:00,16:00-21:00",
 *   "Su off", "10:00-22:00", overnight "18:00-02:00". Later rules override earlier ones for the days they name.
 */
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
type Rule = { days: boolean[]; ranges: [number, number][]; off: boolean };

function parseDays(s: string): boolean[] | null {
  const out = Array(7).fill(false);
  for (const part of s.split(',')) {
    const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part.trim());
    if (!m) return null;
    const a = DAYS.indexOf(m[1]), b = m[2] ? DAYS.indexOf(m[2]) : a;
    for (let i = a; ; i = (i + 1) % 7) { out[i] = true; if (i === b) break; }
  }
  return out;
}
const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };

export function parseOH(oh: string): Rule[] | null {
  const s = oh.trim();
  if (!s) return null;
  if (s === '24/7') return [{ days: Array(7).fill(true), ranges: [[0, 1440]], off: false }];
  const rules: Rule[] = [];
  for (const raw of s.split(';')) {
    const r = raw.trim().replace(/\bPH\b[^;]*/, '').trim();
    if (!r) continue;
    const m = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)?\s*(.*)$/.exec(r);
    if (!m) return null;
    const days = m[1] ? parseDays(m[1].replace(/,$/, '')) : Array(7).fill(true);
    if (!days) return null;
    const rest = m[2].trim();
    if (/^(off|closed)$/i.test(rest)) { rules.push({ days, ranges: [], off: true }); continue; }
    if (rest === '24/7' || rest === '00:00-24:00') { rules.push({ days, ranges: [[0, 1440]], off: false }); continue; }
    const ranges: [number, number][] = [];
    for (const t of rest.split(',')) {
      const tm = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/.exec(t.trim());
      if (!tm) return null;
      ranges.push([mins(tm[1]), mins(tm[2])]);
    }
    if (!ranges.length) return null;
    rules.push({ days, ranges, off: false });
  }
  return rules.length ? rules : null;
}

/** Ranges that apply on weekday d (0 = Monday): the last rule naming that day wins. */
function dayRanges(rules: Rule[], d: number): [number, number][] {
  let out: [number, number][] = [];
  for (const r of rules) if (r.days[d]) out = r.off ? [] : r.ranges;
  return out;
}

export interface OpenState { open: boolean; text: string }
/** Is it open at `when`? null when the hours can't be read. */
export function openState(oh: string, when = new Date()): OpenState | null {
  const rules = parseOH(oh);
  if (!rules) return null;
  const d = (when.getDay() + 6) % 7, t = when.getHours() * 60 + when.getMinutes();
  const fmt = (m: number) => { const h = Math.floor(m / 60) % 24, mm = m % 60; return new Date(2000, 0, 1, h, mm).toLocaleTimeString('en-IN', { hour: 'numeric', minute: mm ? '2-digit' : undefined }); };
  if (oh.trim() === '24/7') return { open: true, text: 'Open 24 hours' };
  // today, plus yesterday's ranges that run past midnight
  for (const [a, b] of dayRanges(rules, d)) {
    if (b > a ? t >= a && t < b : t >= a) return { open: true, text: b === 1440 || (b > a && b >= 1440) ? 'Open till midnight' : `Open · closes ${fmt(b)}` };
  }
  for (const [a, b] of dayRanges(rules, (d + 6) % 7)) if (b < a && t < b) return { open: true, text: `Open · closes ${fmt(b)}` };
  // next opening within a week
  for (let k = 0; k < 7; k++) {
    const day = (d + k) % 7;
    const next = dayRanges(rules, day).map(([a]) => a).filter((a) => k > 0 || a > t).sort((x, y) => x - y)[0];
    if (next !== undefined) return { open: false, text: `Closed · opens ${k === 0 ? '' : k === 1 ? 'tomorrow ' : DAYS[day] + ' '}${fmt(next)}` };
  }
  return { open: false, text: 'Closed' };
}
