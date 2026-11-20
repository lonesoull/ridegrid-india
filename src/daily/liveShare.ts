import mqtt from 'mqtt';
import { deriveTeam, seal, open } from '../team/crypto';
import { DEFAULT_BROKER } from '../team/team';
import { nav } from '../nav/navigator';
import { watchGps } from '../nav/gps';
import type { LngLat } from '../core/geo';

/**
 * Live location link (OsmAnd "Live monitoring"): family / friends open a link and watch the rider on a
 * map — no app or account. Positions are end-to-end encrypted with a key that exists only in the link
 * (after the #), sent through the same public MQTT broker as the team link, and cleared when sharing stops.
 */
export interface SharePos { p: LngLat; spd: number; hd: number; acc: number; t: number; name: string; until: number; dest?: string }
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(25)), (b) => ALPHA[b % ALPHA.length]).join('');
const chan = async (code: string) => { const d = await deriveTeam(`share:${code}`); return { topic: `rgs1/${d.topicId}`, key: d.key }; };

export const liveShare = {
  on: false, code: '', until: 0, sent: 0,
  client: null as mqtt.MqttClient | null, stopGps: null as null | (() => void), timer: 0 as any, last: null as SharePos | null,
  listeners: new Set<() => void>(),
  emit() { this.listeners.forEach((f) => f()); },
  link() { return `${location.origin}${location.pathname}#watch=${this.code}`; },

  async start(hours: number, name: string) {
    await this.stop();
    this.code = newCode(); this.until = hours > 0 ? Date.now() + hours * 3600000 : 0; this.on = true;
    const { topic, key } = await chan(this.code);
    const client = mqtt.connect(DEFAULT_BROKER, { clientId: `rgs-${Math.random().toString(36).slice(2, 10)}`, clean: true, keepalive: 30, reconnectPeriod: 3000 });
    this.client = client;
    let own: LngLat | null = null, ownAcc = 0, ownSpd = 0, ownHd = 0;
    if (nav.mode !== 'live') this.stopGps = await watchGps((f) => { own = [f.lng, f.lat]; ownAcc = f.acc; ownSpd = f.speed ?? 0; ownHd = f.heading ?? 0; }, () => {});
    const tick = async () => {
      if (this.until && Date.now() > this.until) { await this.stop(); return; }
      const p = nav.mode === 'live' && nav.pos ? nav.pos : own;
      if (!p || !client.connected) return;
      const msg: SharePos = { p, spd: nav.mode === 'live' ? nav.speedMps : ownSpd, hd: nav.mode === 'live' ? nav.heading : ownHd, acc: nav.mode === 'live' ? nav.accuracy : ownAcc, t: Date.now(), name, until: this.until };
      client.publish(topic, (await seal(key, msg)) as any, { retain: true, qos: 1 });
      this.last = msg; this.sent++; this.emit();
    };
    this.timer = setInterval(() => void tick(), 10000);
    client.on('connect', () => void tick());
    this.emit();
    return this.link();
  },
  async stop() {
    if (!this.on) return;
    clearInterval(this.timer);
    this.stopGps?.(); this.stopGps = null;
    const c = this.client;
    if (c) { const { topic } = await chan(this.code); c.publish(topic, '', { retain: true, qos: 1 }, () => c.end(true)); }
    this.client = null; this.on = false; this.code = ''; this.emit();
  },
};

/** Viewer side: subscribe to a shared link's channel. */
export async function watchShare(code: string, onPos: (p: SharePos | null) => void) {
  const { topic, key } = await chan(code);
  const client = mqtt.connect(DEFAULT_BROKER, { clientId: `rgw-${Math.random().toString(36).slice(2, 10)}`, clean: true, keepalive: 30, reconnectPeriod: 3000 });
  client.on('connect', () => client.subscribe(topic, { qos: 1 }));
  client.on('message', async (_t, payload) => {
    if (!payload.length) { onPos(null); return; }
    onPos(await open<SharePos>(key, new Uint8Array(payload)));
  });
  return () => client.end(true);
}
