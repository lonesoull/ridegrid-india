import { useState } from 'react';
import { engine } from '../core/engine';
import { fmtKm } from '../core/geo';
import { nav } from '../nav/navigator';
import { buildRouteLine } from '../nav/routeLine';
import { checkRoute, ISSUE_LABEL, type CheckResult, type IssueKind } from '../nav/checker';
import { ui, act } from './state';
import { mapCtl } from './App';
import { useEngine } from './hooks';

let last: { result: CheckResult; version: number; stopS: Float64Array } | null = null;
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
    const result = await checkRoute(L, { gapM: nav.settings.gapM, onProgress: (f) => setBusy(f) });
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
        <div className="list">
          {res.issues.slice(page * PER, page * PER + PER).map((x, j) => (
            <div className="item tight" key={j}>
              <button className="link" onClick={() => { mapCtl?.map.flyTo({ center: x.p, zoom: 17 }); ui.set({ drawer: false }); }}>
                <b className={x.kind === 'parallel' ? 'warn' : 'danger-text'}>{ISSUE_LABEL[x.kind]}</b>
                <div className="muted">at {fmtKm(x.s1)} (near #{wp(x.s1) + 1}) ↔ at {fmtKm(x.s2)} (near #{wp(x.s2) + 1}) · {Math.round(x.d)} m apart{x.s1End > x.s1 + 20 ? ` · ${Math.round(x.s1End - x.s1)} m long` : ''}</div>
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
