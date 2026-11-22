import { useEffect, useRef, useState } from 'react';
import { ui, toast } from './state';

/**
 * Android back (button or edge-swipe gesture) and the browser's back: closes the top-most open thing
 * — search, sheet, card, settings page, menu — like Google Maps. On the plain map, back twice minimises
 * the app (it is never killed, so ride tracking keeps going). During navigation back never ends the ride.
 */
type Entry = { id: number; close: () => void };
const stack: Entry[] = [];
let seq = 0;

/** While `active`, the phone's Back closes this (last opened = first closed). */
export function useBack(active: boolean, close: () => void) {
  const fn = useRef(close); fn.current = close;
  // after Back fires, register again if this is still open (e.g. a wizard going one step back)
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!active) return;
    const e: Entry = { id: ++seq, close: () => { fn.current(); setRound((r) => r + 1); } };
    stack.push(e);
    return () => { const i = stack.indexOf(e); if (i >= 0) stack.splice(i, 1); };
  }, [active, round]);
}

let lastBack = 0;
export let navActive: () => boolean = () => false;
export function setNavActive(f: () => boolean) { navActive = f; }

/** Returns true when the app handled Back itself (false = let the app go to the background). */
export function handleBack(): boolean {
  if (document.querySelector('.screenlock')) { toast('Screen locked — hold the button to unlock'); return true; }
  const top = stack.pop();
  if (top) { top.close(); return true; }
  if (navActive()) { toast('Navigation is running — tap ✕ in the panel to end it'); return true; }
  if (Date.now() - lastBack < 2000) return false;
  lastBack = Date.now();
  toast('Press back again to exit');
  return true;
}

export async function startBackHandling() {
  const { Capacitor } = await import('@capacitor/core');
  if (Capacitor.isNativePlatform()) {
    const { App } = await import('@capacitor/app');
    await App.addListener('backButton', () => { if (!handleBack()) void App.minimizeApp(); });
    return;
  }
  // browser / installed web app: keep one extra history entry so Back comes to us first
  window.history.pushState({ rgBack: 1 }, '');
  window.addEventListener('popstate', () => {
    if (handleBack()) window.history.pushState({ rgBack: 1 }, '');
    else window.history.back();
  });
}
// keep ui import used for future checks (mode picker etc. register through useBack)
void ui;
