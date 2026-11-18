import { isExpedition } from '../core/terms';
import { useState } from 'react';
import { engine } from '../core/engine';
import { fmtKm } from '../core/geo';
import { nav } from '../nav/navigator';
import { buildRouteLine } from '../nav/routeLine';
import { checkRoute, deadEndSpurs, ISSUE_LABEL, type CheckResult, type IssueKind } from '../nav/checker';
import { routeOnExpressways } from '../nav/expressways';
import { ui, act, toast } from './state';
import { mapCtl } from './App';
import { useEngine } from './hooks';

let last: { result: CheckResult; version: number; stopS: Float64Array } | null = null;
let exMissing = false;
const PER = 50;

/** Scans the planned route against itself for Guinness rule problems and lists them on the map. */
export function RouteChecker() {
  useEngine();
  const [busy, setBusy] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [, force] = useState(0);
  const run = () => act(null, async () => {
    setBusy(0);
    const L = buildRouteLine();
    const result = await checkRoute(L, { gapM: nav.settings.gapM, onProgress: (f) => setBusy(f * 0.6) });
    // Guinness/India: no riding on two-wheeler-banned expressways
    const ex = isExpedition() ? await routeOnExpressways(L, (f) => setBusy(0.6 + f * 0.35)) : [];
    if (ex === null) exMissing = true;
    else { exMissing = false; for (const x of ex) result.issues.push({ kind: 'expressway', s1: x.s1, s1End: x.s1End, s2: x.s1End, d: x.d, p: x.p, p2: x.p2, label: x.road.name }); }
    for (const sp of deadEndSpurs(L)) result.issues.push(sp);
    result.issues.sort((a, b) => a.s1 - b.s1);
    last = { result, version: engine.version, stopS: L.stopS };
    mapCtl?.setIssues(result.issues);
    setBusy(null); setPage(0); force((x) => x + 1);
  });
  const res = last?.result;
  const counts = res ? res.issues.reduce((a, x) => ((a[x.kind] = (a[x.kind] ?? 0) + 1), a), {} as Partial<Record<IssueKind, number>>) : {};
  const wp = (s: number) => { const S = last!.stopS; let k = 0; while (k < S.length && S[k] < s) k++; return k; };
  const stale = last && last.version !== engine.version;
  const pending = engine.pendingLegs + engine.errorLegs;
  return (
    <section>
      <h3>Route checker</h3>
      <p className="muted">Scans the whole planned route against itself: crossings, the same road twice, any part within {nav.settings.gapM} m of another part,
        and parallel carriageways / service roads. Fix every red marker before riding.</p>
      {pending > 0 && <p className="warn">{pending.toLocaleString('en-IN')} legs aren't road-mapped yet — they're checked as straight lines, so results there are approximate.</p>}
      <div className="btns">
        <button className="primary" disabled={busy !== null || engine.stops.length < 2} onClick={run}>{busy !== null ? `Checking… ${Math.round(busy * 100)}%` : last ? 'Check again' : 'Check route'}</button>
        {res && <button onClick={() => { last = null; mapCtl?.setIssues(null); force((x) => x + 1); }}>Clear markers</button>}
      </div>
      {res && <>
        <p className={res.issues.length ? 'warn' : 'muted'}>
          {res.issues.length ? `${res.issues.length.toLocaleString('en-IN')}${res.truncated ? '+' : ''} issue(s)` : '✅ No issues found'} · checked {res.samples.toLocaleString('en-IN')} points in {(res.ms / 1000).toFixed(1)} s
          {stale ? ' · route changed since — check again' : ''}
        </p>
        {res.issues.length > 0 && <p className="muted">{(Object.keys(counts) as IssueKind[]).map((k) => `${ISSUE_LABEL[k]}: ${counts[k]}`).join(' · ')}</p>}
        {exMissing && <p className="warn">Expressway data isn't available yet, so banned roads weren't checked (it downloads with the next app update).</p>}
        {(counts.expressway ?? 0) > 0 && <button className="primary" onClick={() => act('Re-routing legs that use expressways…', async () => {
          const S = last!.stopS; let n = 0;
          for (const x of res.issues.filter((i) => i.kind === 'expressway')) for (let i = 0; i < S.length - 1; i++) if (S[i + 1] >= x.s1 && S[i] <= x.s1End) { await engine.rerouteLeg(i); n++; }
          toast(`Re-routing ${n} leg(s) without expressways — check again in a minute`);
        })}>Re-route legs that use expressways</button>}
        <div className="list">
          {res.issues.slice(page * PER, page * PER + PER).map((x, j) => (
            <div className="item tight" key={j}>
              <button className="link" onClick={() => { mapCtl?.map.flyTo({ center: x.p, zoom: 17 }); ui.set({ drawer: false }); }}>
                <b className={x.kind === 'parallel' || x.kind === 'spur' ? 'warn' : 'danger-text'}>{ISSUE_LABEL[x.kind]}</b>
                {x.kind === 'expressway' || x.kind === 'spur'
                  ? <div className="muted">{x.label ? `${x.label} · ` : ''}from {fmtKm(x.s1)} (near #{wp(x.s1) + 1}){x.s1End > x.s1 + 20 ? ` · ${Math.round(x.s1End - x.s1)} m` : ''}</div>
                  : <div className="muted">at {fmtKm(x.s1)} (near #{wp(x.s1) + 1}) ↔ at {fmtKm(x.s2)} (near #{wp(x.s2) + 1}) · {Math.round(x.d)} m apart{x.s1End > x.s1 + 20 ? ` · ${Math.round(x.s1End - x.s1)} m long` : ''}</div>}
              </button>
            </div>
          ))}
        </div>
        {res.issues.length > PER && <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>◀ Prev</button>
          <span>{page * PER + 1}–{Math.min(res.issues.length, page * PER + PER)} of {res.issues.length}</span>
          <button disabled={(page + 1) * PER >= res.issues.length} onClick={() => setPage(page + 1)}>Next ▶</button>
        </div>}
      </>}
    </section>
  );
}
