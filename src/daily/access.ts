import { getSetting, putSetting } from '../core/db';
import { mode } from '../core/mode';

/** Daily accessibility: bigger text, high contrast, vibration on alerts and turns. */
export interface Access { scale: number; contrast: boolean; vibrate: boolean }
export const access = {
  s: { scale: 1, contrast: false, vibrate: true } as Access,
  async load() { this.s = { ...this.s, ...(await getSetting<Partial<Access>>('access', {})) }; this.apply(); },
  async save(p: Partial<Access>) { this.s = { ...this.s, ...p }; await putSetting('access', this.s); this.apply(); },
  apply() {
    const r = document.documentElement;
    const on = mode.current === 'daily';
    r.style.setProperty('--ui-scale', String(on ? this.s.scale : 1));
    r.classList.toggle('hc', on && this.s.contrast);
  },
  buzz(pattern: number | number[] = 200) { if (mode.current === 'daily' && this.s.vibrate) try { navigator.vibrate?.(pattern); } catch { /* ignore */ } },
};
