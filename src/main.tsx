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
(window as any).__rg = { engine, app };
