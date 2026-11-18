import mqtt, { type MqttClient } from 'mqtt';
import { getSetting, putSetting, uid } from '../core/db';
import type { LngLat } from '../core/geo';
import { deriveTeam, newPairingCode, normalizeCode, open, seal } from './crypto';

export type Role = 'primary' | 'secondary' | 'laptop';
export const ROLE_LABEL: Record<Role, string> = { primary: 'Primary phone', secondary: 'Secondary phone', laptop: 'Laptop' };
/** Free public MQTT relay (end-to-end encrypted). All team devices must use the same relay. */
export const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';

export interface TeamSettings { code: string; deviceId: string; name: string; role: Role; broker: string }

export interface PeerNav {
  mode: 'live' | 'sim'; kind: 'expedition' | 'daily'; trip: string;
  next: number; total: number; toNext: number; remaining: number; etaS: number;
  turn?: { c: string; txt: string; dist: number } | null;
  offRoute: boolean; offDist: number; guard?: { level: string; d: number } | null; detour: boolean;
}
export interface PeerState {
  id: string; name: string; role: Role; online: boolean; t: number;
  pos?: LngLat; hd?: number; spd?: number; acc?: number; bat?: number; charging?: boolean;
  nav?: PeerNav | null;
}
export interface Peer extends PeerState { lastSeen: number; track: LngLat[] }

export type TeamEvent =
  | { type: 'sos'; from: string; name: string; pos: LngLat; acc?: number; t: number; msg?: string }
  | { type: 'sos-ack'; from: string; name: string; to: string; t: number }
  | { type: 'track'; from: string; pts: [number, number, number][] }
  | { type: 'route-offer'; from: string; name: string; routeId: string; title: string; kind: 'expedition' | 'daily'; count: number; parts: number }
  | { type: 'route-part'; from: string; routeId: string; i: number; data: string }
  | { type: 'stop'; from: string; name: string; label: string; pos: LngLat; t: number; place?: string };

type Status = 'off' | 'connecting' | 'online' | 'offline';

class Team {
  settings: TeamSettings | null = null;
  status: Status = 'off';
  lastError = '';
  peers = new Map<string, Peer>();
  version = 0;
  private client: MqttClient | null = null;
  private key: CryptoKey | null = null;
  private base = '';
  private queue: TeamEvent[] = [];
  private listeners = new Set<() => void>();
  private evListeners = new Set<(e: TeamEvent) => void>();

  subscribe(f: () => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  onEvent(f: (e: TeamEvent) => void) { this.evListeners.add(f); return () => { this.evListeners.delete(f); }; }
  private emit() { this.version++; this.listeners.forEach((f) => f()); }

  get me() { return this.settings; }
  get inviteLink() { return this.settings ? `${location.origin}${location.pathname}#join=${this.settings.code}` : ''; }

  async load() {
    this.settings = await getSetting<TeamSettings | null>('team', null);
    if (this.settings) await this.connect();
    return this.settings;
  }
  async create(name: string, role: Role) { return this.join(newPairingCode(), name, role); }
  async join(code: string, name: string, role: Role) {
    this.disconnect();
    const prev = this.settings;
    this.settings = { code: normalizeCode(code), deviceId: prev?.deviceId ?? uid(), name: name.trim() || ROLE_LABEL[role], role, broker: prev?.broker ?? DEFAULT_BROKER };
    await putSetting('team', this.settings);
    this.peers.clear();
    await this.connect();
  }
  async update(p: Partial<Pick<TeamSettings, 'name' | 'role' | 'broker'>>) {
    if (!this.settings) return;
    const reconnect = p.broker !== undefined && p.broker !== this.settings.broker;
    this.settings = { ...this.settings, ...p };
    await putSetting('team', this.settings);
    if (reconnect) { this.disconnect(); await this.connect(); } else this.emit();
  }
  async leave() {
    if (this.client && this.key && this.settings) {
      // clear our retained presence so others stop seeing us
      this.client.publish(`${this.base}/p/${this.settings.deviceId}`, new Uint8Array(0) as any, { retain: true, qos: 1 });
    }
    this.disconnect();
    this.settings = null; this.peers.clear();
    await putSetting('team', null);
    this.emit();
  }

  private disconnect() {
    try { this.client?.end(true); } catch { /* */ }
    this.client = null; this.status = 'off';
  }

  private async connect() {
    const s = this.settings;
    if (!s) return;
    const { topicId, key } = await deriveTeam(s.code);
    this.key = key; this.base = `rg1/${topicId}`;
    this.status = 'connecting'; this.emit();
    const offline = await seal(key, { id: s.deviceId, name: s.name, role: s.role, online: false, t: Date.now() } satisfies PeerState);
    const client = mqtt.connect(s.broker, {
      clientId: `rg-${s.deviceId}-${Math.random().toString(36).slice(2, 7)}`,
      clean: true, keepalive: 20, reconnectPeriod: 2000, connectTimeout: 10000,
      will: { topic: `${this.base}/p/${s.deviceId}`, payload: offline as any, retain: true, qos: 1 },
    });
    this.client = client;
    client.on('connect', () => {
      this.status = 'online'; this.lastError = '';
      client.subscribe([`${this.base}/p/+`, `${this.base}/e`], { qos: 1 });
      const q = this.queue; this.queue = [];
      q.forEach((e) => void this.send(e));
      this.emit();
    });
    client.on('message', (topic, payload) => void this.onMessage(topic, new Uint8Array(payload)));
    client.on('offline', () => { this.status = 'offline'; this.emit(); });
    client.on('reconnect', () => { if (this.status !== 'online') { this.status = 'connecting'; this.emit(); } });
    client.on('error', (e) => { this.lastError = e?.message ?? String(e); this.emit(); });
  }

  private async onMessage(topic: string, payload: Uint8Array) {
    if (!this.key || !this.settings) return;
    if (topic.startsWith(`${this.base}/p/`)) {
      const id = topic.slice(this.base.length + 3);
      if (id === this.settings.deviceId) return;
      if (!payload.length) { this.peers.delete(id); this.emit(); return; }
      const st = await open<PeerState>(this.key, payload);
      if (!st) return;
      const prev = this.peers.get(id);
      const track = prev?.track ?? [];
      if (st.pos && st.nav) {
        const last = track[track.length - 1];
        if (!last || last[0] !== st.pos[0] || last[1] !== st.pos[1]) track.push(st.pos);
        if (track.length > 20000) track.splice(0, track.length - 20000);
      }
      this.peers.set(id, { ...st, lastSeen: Date.now(), track });
      this.emit();
      return;
    }
    const ev = await open<TeamEvent>(this.key, payload);
    if (!ev || ev.from === this.settings.deviceId) return;
    if (ev.type === 'track') {
      const p = this.peers.get(ev.from);
      if (p) { p.track.push(...ev.pts.map(([, lng, lat]) => [lng, lat] as LngLat)); this.emit(); }
    }
    this.evListeners.forEach((f) => f(ev));
  }

  /** Latest state of this device (retained, so a device joining later sees it immediately). */
  async publishState(st: Omit<PeerState, 'id' | 'name' | 'role' | 't'>) {
    if (!this.client || !this.key || !this.settings || this.status !== 'online') return false;
    const s = this.settings;
    const msg = await seal(this.key, { ...st, id: s.deviceId, name: s.name, role: s.role, t: Date.now() } satisfies PeerState);
    this.client.publish(`${this.base}/p/${s.deviceId}`, msg as any, { retain: true, qos: 0 });
    return true;
  }

  /** One-off event to the whole team; queued while offline and sent on reconnect. */
  async send(e: TeamEvent) {
    if (!this.client || !this.key || this.status !== 'online') { this.queue.push(e); if (this.queue.length > 500) this.queue.shift(); return; }
    this.client.publish(`${this.base}/e`, (await seal(this.key, e)) as any, { qos: 1 });
  }
}

export const team = new Team();
