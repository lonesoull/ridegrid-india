import type { LngLat } from '../core/geo';
import { pointAt, type RouteLine } from './routeLine';
import { SegIndex, isParallel } from './spatial';

export type IssueKind = 'crossing' | 'overlap' | 'close' | 'parallel';
export interface Issue { kind: IssueKind; s1: number; s1End: number; s2: number; d: number; p: LngLat; p2: LngLat }
export interface CheckResult { issues: Issue[]; samples: number; ms: number; truncated: boolean }

export const ISSUE_LABEL: Record<IssueKind, string> = {
  crossing: 'Crosses itself', overlap: 'Same road ridden twice', close: 'Too close to another part', parallel: 'Parallel road (other carriageway / service road)',
};

/**
 * Scan the whole planned route against itself (Guinness rule: no repeated road, no crossing,
 * keep `gapM` from every other part, no parallel carriageway / service road).
 * Samples every ~15 m; parts of the route within `skipM` along-route distance are neighbours, not issues.
 */
export async function checkRoute(L: RouteLine, opts: { gapM: number; parallelM?: number; onProgress?: (f: number) => void; maxIssues?: number }): Promise<CheckResult> {
  const t0 = performance.now();
  const gap = opts.gapM, parM = opts.parallelM ?? 80, maxIssues = opts.maxIssues ?? 5000;
  const idx = new SegIndex(L);
  const step = Math.max(10, gap / 2);
  const skipM = Math.max(150, gap * 4);
  const issues: Issue[] = [];
  let cur: Issue | null = null;
  let parRun = 0, parStart = 0;
  let samples = 0;
  const flush = () => { if (cur) { issues.push(cur); cur = null; } };
  for (let s = 0; s <= L.total; s += step) {
    samples++;
    const at = pointAt(L, s);
    // look only at later parts of the route (each pair reported once), ignoring immediate neighbours
    const near = idx.nearest(at.p, parM, [[-Infinity, s + skipM]]);
    let kind: IssueKind | null = null;
    if (near) {
      const par = isParallel(at.heading, near.bearing);
      if (near.d < gap) kind = near.d < Math.max(8, step * 0.6) && !par ? 'crossing' : par ? 'overlap' : 'close';
      if (par && near.d <= parM) { if (!parRun) parStart = s; parRun += step; } else parRun = 0;
      if (!kind && parRun >= 100) kind = 'parallel';
    } else parRun = 0;
    if (kind && near) {
      const sameRun = cur && cur.kind === kind && s - cur.s1End <= step * 2 + 1 && Math.abs(near.s - cur.s2) < 500;
      if (sameRun) { cur!.s1End = s; if (near.d < cur!.d) cur!.d = near.d; cur!.s2 = near.s; }
      else { flush(); cur = { kind, s1: kind === 'parallel' ? parStart : s, s1End: s, s2: near.s, d: near.d, p: at.p, p2: near.p }; }
    } else flush();
    if (issues.length >= maxIssues) break;
    if (samples % 20000 === 0) { opts.onProgress?.(s / L.total); await new Promise((r) => setTimeout(r)); }
  }
  flush();
  opts.onProgress?.(1);
  return { issues, samples, ms: performance.now() - t0, truncated: issues.length >= maxIssues };
}
