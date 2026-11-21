import './core/net';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(<App />);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => undefined));
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => undefined);

// debug handle for testing from the browser console
import { engine } from './core/engine';
import { app } from './core/app';
import { nav } from './nav/navigator';
import { team } from './team/team';
(window as any).__rg = { engine, app, nav, team };
import { mapCtl } from './ui/App';
setTimeout(() => { (window as any).__map = mapCtl?.map; }, 500);
