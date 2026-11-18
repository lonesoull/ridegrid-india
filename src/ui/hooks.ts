import { useEffect, useState, useSyncExternalStore } from 'react';
import { engine } from '../core/engine';
import { app } from '../core/app';

/** Re-render whenever the route engine changes (throttled to one render per frame). */
export function useEngine() {
  return useSyncExternalStore(subscribeThrottled, () => engine.version);
}
const subs = new Set<() => void>();
let raf = 0;
engine.subscribe(() => {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; subs.forEach((f) => f()); });
});
function subscribeThrottled(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }

export function useRouterStatus() {
  const [, set] = useState(0);
  useEffect(() => app.queue.onStatus(() => set((x) => x + 1)), []);
  return app.queue.status;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | undefined, () => void] {
  const [v, setV] = useState<T>();
  const [n, setN] = useState(0);
  useEffect(() => { let live = true; fn().then((x) => live && setV(x)); return () => { live = false; }; }, [...deps, n]);
  return [v, () => setN((x) => x + 1)];
}
