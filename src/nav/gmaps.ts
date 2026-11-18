import { engine } from '../core/engine';

/** Google Maps allows origin + 9 waypoints + destination per link = 10 legs, in exactly this order. */
export const LEGS_PER_STAGE = 10;

export interface Stage { n: number; from: number; to: number; url: string }

const ll = (i: number) => `${engine.stops[i].lat.toFixed(6)},${engine.stops[i].lng.toFixed(6)}`;

export function stageUrl(from: number, to: number): string {
  const wps: string[] = [];
  for (let i = from + 1; i < to; i++) wps.push(ll(i));
  const q = new URLSearchParams({ api: '1', origin: ll(from), destination: ll(to), travelmode: 'two-wheeler' });
  let url = `https://www.google.com/maps/dir/?${q.toString()}`;
  if (wps.length) url += `&waypoints=${wps.map(encodeURIComponent).join('%7C')}`;
  return url;
}

export function stageCount() { return Math.max(0, Math.ceil((engine.stops.length - 1) / LEGS_PER_STAGE)); }

/** Stage k covers stops k*10 … k*10+10 (0-based); consecutive stages share their end/start stop. */
export function stage(k: number): Stage | null {
  const n = engine.stops.length;
  if (n < 2 || k < 0 || k >= stageCount()) return null;
  const from = k * LEGS_PER_STAGE, to = Math.min(n - 1, from + LEGS_PER_STAGE);
  return { n: k + 1, from, to, url: stageUrl(from, to) };
}

/** Stage containing the leg that starts at stop index i. */
export const stageOfStop = (i: number) => Math.min(stageCount() - 1, Math.floor(Math.max(0, i) / LEGS_PER_STAGE));

export function stagesCSV(): string {
  const rows = ['stage,from_stop_no,to_stop_no,google_maps_url'];
  for (let k = 0; k < stageCount(); k++) { const s = stage(k)!; rows.push(`${s.n},${s.from + 1},${s.to + 1},"${s.url}"`); }
  return rows.join('\n');
}
