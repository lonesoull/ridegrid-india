import { BleClient } from '@capacitor-community/bluetooth-le';

/**
 * Bluetooth sensors (OsmAnd "External sensors"): heart-rate straps, speed/cadence sensors and
 * temperature sensors using the standard Bluetooth LE services. Works in the Android app and in
 * Chrome on the laptop.
 */
const HR = '0000180d-0000-1000-8000-00805f9b34fb', HR_M = '00002a37-0000-1000-8000-00805f9b34fb';
const CSC = '00001816-0000-1000-8000-00805f9b34fb', CSC_M = '00002a5b-0000-1000-8000-00805f9b34fb';
const ENV = '0000181a-0000-1000-8000-00805f9b34fb', TEMP = '00002a6e-0000-1000-8000-00805f9b34fb';
const BATT = '0000180f-0000-1000-8000-00805f9b34fb', BATT_L = '00002a19-0000-1000-8000-00805f9b34fb';

export interface SensorDev { id: string; name: string; kind: 'hr' | 'csc' | 'temp'; battery?: number }
export const sensors = {
  devices: [] as SensorDev[],
  hr: null as number | null, cadence: null as number | null, speedKmh: null as number | null, tempC: null as number | null,
  wheelMm: 2050,
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  inited: false,
  async init() { if (!this.inited) { await BleClient.initialize({ androidNeverForLocation: true }); this.inited = true; } },

  async pair(kind: SensorDev['kind']) {
    await this.init();
    const service = kind === 'hr' ? HR : kind === 'csc' ? CSC : ENV;
    const dev = await BleClient.requestDevice({ services: [service], optionalServices: [BATT] });
    await BleClient.connect(dev.deviceId, () => { this.devices = this.devices.filter((d) => d.id !== dev.deviceId); this.emit(); });
    const d: SensorDev = { id: dev.deviceId, name: dev.name || kind.toUpperCase(), kind };
    this.devices = [...this.devices.filter((x) => x.id !== d.id), d];
    try { d.battery = (await BleClient.read(dev.deviceId, BATT, BATT_L)).getUint8(0); } catch { /* no battery service */ }
    if (kind === 'hr') await BleClient.startNotifications(dev.deviceId, HR, HR_M, (v) => { const f = v.getUint8(0); this.hr = f & 1 ? v.getUint16(1, true) : v.getUint8(1); this.emit(); });
    if (kind === 'csc') {
      let lastWheel: [number, number] | null = null, lastCrank: [number, number] | null = null;
      await BleClient.startNotifications(dev.deviceId, CSC, CSC_M, (v) => {
        const f = v.getUint8(0); let o = 1;
        if (f & 1) {
          const rev = v.getUint32(o, true), t = v.getUint16(o + 4, true); o += 6;
          if (lastWheel) { const dr = rev - lastWheel[0], dt = ((t - lastWheel[1] + 65536) % 65536) / 1024; if (dt > 0) this.speedKmh = ((dr * this.wheelMm) / 1000 / dt) * 3.6; }
          lastWheel = [rev, t];
        }
        if (f & 2) {
          const rev = v.getUint16(o, true), t = v.getUint16(o + 2, true);
          if (lastCrank) { const dr = (rev - lastCrank[0] + 65536) % 65536, dt = ((t - lastCrank[1] + 65536) % 65536) / 1024; if (dt > 0) this.cadence = (dr / dt) * 60; }
          lastCrank = [rev, t];
        }
        this.emit();
      });
    }
    if (kind === 'temp') await BleClient.startNotifications(dev.deviceId, ENV, TEMP, (v) => { this.tempC = v.getInt16(0, true) / 100; this.emit(); });
    this.emit();
    return d;
  },
  async forget(id: string) { try { await BleClient.disconnect(id); } catch { /* gone */ } this.devices = this.devices.filter((d) => d.id !== id); this.emit(); },
};
