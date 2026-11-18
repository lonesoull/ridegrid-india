import { useSyncExternalStore } from 'react';

export type TapMode = 'append' | 'insert' | 'off';
export interface UIState {
  selectedId: string | null;
  tapMode: TapMode;
  snapToRoad: boolean;
  night: boolean;
  drawer: boolean;
  tab: 'trip' | 'stops' | 'ride' | 'files' | 'tools';
  following: boolean;
  /** next map tap inserts a stop at this index */
  insertAt: number | null;
  /** bumps when Google settings change (re-render dependants) */
  gtick: number;
  toast: { msg: string; kind: 'info' | 'error'; at: number } | null;
  fps: boolean;
  busy: string | null;
}

let state: UIState = {
  selectedId: null, tapMode: 'append', snapToRoad: true,
  night: typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches,
  drawer: false, tab: 'trip', following: true, insertAt: null, gtick: 0, toast: null, fps: false, busy: null,
};
const subs = new Set<() => void>();

export const ui = {
  get: () => state,
  set(patch: Partial<UIState>) { state = { ...state, ...patch }; subs.forEach((f) => f()); },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

export function useUI<T>(sel: (s: UIState) => T): T {
  return useSyncExternalStore(ui.subscribe, () => sel(state));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, kind: 'info' | 'error' = 'info') {
  ui.set({ toast: { msg, kind, at: Date.now() } });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.set({ toast: null }), kind === 'error' ? 6000 : 3000);
}

/** Run an async action with a busy label and error toast. */
export async function act<T>(label: string | null, fn: () => Promise<T>): Promise<T | undefined> {
  if (label) ui.set({ busy: label });
  try { return await fn(); }
  catch (e: any) { toast(e?.message || String(e), 'error'); return undefined; }
  finally { if (label) ui.set({ busy: null }); }
}
