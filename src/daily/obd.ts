import { BleClient, numbersToDataView } from '@capacitor-community/bluetooth-le';

/**
 * OBD-II engine data (OsmAnd "Vehicle metrics" / OBD plugin) through a Bluetooth LE ELM327 adapter
 * (e.g. Vgate iCar Pro BLE). Indian BS6 motorcycles have an OBD port; which values a bike reports varies.
 */
const SERVICES: [string, string, string][] = [ // service, notify, write
  ['0000fff0-0000-1000-8000-00805f9b34fb', '0000fff1-0000-1000-8000-00805f9b34fb', '0000fff2-0000-1000-8000-00805f9b34fb'],
  ['0000ffe0-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb'],
  ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'],
];
export interface ObdValues { rpm?: number; kmh?: number; coolant?: number; load?: number; throttle?: number; fuel?: number; volts?: number; intake?: number; oil?: number }

/** Decode one "41 xx .." reply. */
export function parsePid(reply: string): Partial<ObdValues> {
  const b = reply.replace(/[^0-9A-F ]/gi, ' ').trim().split(/\s+/).map((x) => parseInt(x, 16));
  const i = b.indexOf(0x41);
  if (i < 0) return {};
  const [pid, A = 0, B = 0] = b.slice(i + 1);
  switch (pid) {
    case 0x0c: return { rpm: (A * 256 + B) / 4 };
    case 0x0d: return { kmh: A };
    case 0x05: return { coolant: A - 40 };
    case 0x04: return { load: Math.round((A * 100) / 255) };
    case 0x11: return { throttle: Math.round((A * 100) / 255) };
    case 0x2f: return { fuel: Math.round((A * 100) / 255) };
    case 0x0f: return { intake: A - 40 };
    case 0x5c: return { oil: A - 40 };
    default: return {};
  }
}

export const obd = {
  on: false, name: '', values: {} as ObdValues, error: '',
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  dev: '', svc: SERVICES[0], buf: '', waiter: null as null | ((s: string) => void), timer: 0 as any,

  async connect() {
    await BleClient.initialize({ androidNeverForLocation: true });
    const d = await BleClient.requestDevice({ optionalServices: SERVICES.map((s) => s[0]), namePrefix: undefined });
    await BleClient.connect(d.deviceId, () => { this.on = false; this.emit(); });
    const services = await BleClient.getServices(d.deviceId);
    const svc = SERVICES.find((s) => services.some((x) => x.uuid.toLowerCase() === s[0]));
    if (!svc) { await BleClient.disconnect(d.deviceId); throw new Error('This adapter is not a Bluetooth LE OBD (ELM327) adapter'); }
    this.dev = d.deviceId; this.svc = svc; this.name = d.name ?? 'OBD';
    await BleClient.startNotifications(d.deviceId, svc[0], svc[1], (v) => {
      this.buf += new TextDecoder().decode(v.buffer);
      if (this.buf.includes('>')) { const out = this.buf.replace('>', '').trim(); this.buf = ''; this.waiter?.(out); this.waiter = null; }
    });
    for (const c of ['ATZ', 'ATE0', 'ATL0', 'ATS1', 'ATH0', 'ATSP0']) await this.cmd(c, 3000).catch(() => '');
    this.on = true; this.error = ''; this.emit();
    this.timer = setInterval(() => void this.poll(), 1500);
  },
  cmd(c: string, timeout = 2000): Promise<string> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiter = null; rej(new Error('OBD timeout')); }, timeout);
      this.waiter = (s) => { clearTimeout(t); res(s); };
      void BleClient.write(this.dev, this.svc[0], this.svc[2], numbersToDataView([...new TextEncoder().encode(c + '\r')]));
    });
  },
  busy: false,
  async poll() {
    if (!this.on || this.busy) return;
    this.busy = true;
    try {
      for (const pid of ['010C', '010D', '0105', '0111', '0104', '012F', '010F', '015C']) {
        const r = await this.cmd(pid).catch(() => '');
        if (/NO DATA|ERROR|\?/.test(r)) continue;
        Object.assign(this.values, parsePid(r));
      }
      const v = await this.cmd('ATRV').catch(() => '');
      const volts = parseFloat(v); if (Number.isFinite(volts)) this.values.volts = volts;
      this.emit();
    } finally { this.busy = false; }
  },
  async disconnect() { clearInterval(this.timer); this.on = false; try { await BleClient.disconnect(this.dev); } catch { /* gone */ } this.values = {}; this.emit(); },
};
