/**
 * Real internet check. The phone's own flag says "online" on Wi-Fi without internet or a dead mobile
 * connection, so RideGrid pings Google: offline maps, search and routing take over only when the internet is
 * really gone, and Google comes back as soon as it returns. Everything in the app that reads
 * navigator.onLine — and listens for 'online' / 'offline' — gets this real state.
 */
const proto = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
const deviceOnLine = (): boolean => (proto?.get ? proto.get.call(navigator) : true);
// Google Maps' own server first (that's what must work), then two general Google checks — any answer = online
const PROBES = ['https://maps.googleapis.com/generate_204', 'https://www.google.com/generate_204', 'https://connectivitycheck.gstatic.com/generate_204'];
const realFetch = window.fetch.bind(window);

export const net = {
  online: deviceOnLine(),
  listeners: new Set<(on: boolean) => void>(),
  probing: false,
  set(on: boolean) {
    if (on === this.online) return;
    this.online = on;
    this.listeners.forEach((f) => f(on));
    window.dispatchEvent(new Event(on ? 'online' : 'offline'));
  },
  /** One ping to Google; true when the internet works. */
  async probe(): Promise<boolean> {
    if (!deviceOnLine()) { this.set(false); return false; }
    if (this.probing) return this.online;
    this.probing = true;
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 6000);
      await Promise.any(PROBES.map((u) => realFetch(`${u}?t=${Date.now()}`, { mode: 'no-cors', cache: 'no-store', signal: ac.signal })));
      ac.abort();
      clearTimeout(t);
      lastOk = Date.now();
      this.set(true);
    } catch { this.set(false); } finally { this.probing = false; }
    return this.online;
  },
};

// the whole app sees the real state through navigator.onLine
try { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => net.online }); } catch { /* keep the device flag */ }

// the device's own events: going offline is instant; "back online" is believed only after a successful ping
window.addEventListener('offline', (e) => { if (e.isTrusted) net.set(false); }, true);
window.addEventListener('online', (e) => { if (e.isTrusted) { e.stopImmediatePropagation(); void net.probe(); } }, true);
// keep checking: every 30 s online, every 10 s while the internet is down
setInterval(() => { if (!net.online || Date.now() - lastOk > 25000) void net.probe(); }, 10000);
let lastOk = Date.now();
// any request that fails with a network error → check right away (only the ping proves we're online;
// a cached answer could be served with no internet)
window.fetch = async (...args: Parameters<typeof fetch>) => {
  try { return await realFetch(...args); }
  catch (e: any) { if (e?.name !== 'AbortError') void net.probe(); throw e; }
};
void net.probe();
