import { engine } from '../core/engine';
import { turnText } from '../core/turns';
import { isExpedition } from '../core/terms';
import { nav } from '../nav/navigator';
import { team, type PeerNav } from './team';

/**
 * Shares this device's live state with the team: ~1/sec while riding, every 30 s otherwise.
 * While the connection is down, positions are buffered and sent as one batch on reconnect (no track gaps).
 */
let lastPub = 0;
let pending = false;
let lastPos: string | null = null;
const buffer: [number, number, number][] = [];
let battery: { level: number; charging: boolean } | null = null;

function navState(): PeerNav | null {
  if (nav.mode === 'off' || !nav.line) return null;
  const speed = nav.mode === 'sim' ? (nav.settings.simKmh / 3.6) * nav.mult : Math.max(nav.speedMps, 35 / 3.6);
  const live = nav.liveEta && Date.now() - nav.liveEta.at < 5 * 60000 ? nav.liveEta : null;
  const etaS = live ? live.toNextS + Math.max(0, nav.remaining - nav.distToNext) / speed : nav.remaining / speed;
  const t = nav.nextTurn;
  return {
    mode: nav.mode, kind: isExpedition() ? 'expedition' : 'daily', trip: engine.trip?.name ?? '',
    next: nav.next, total: engine.stops.length, toNext: Math.round(nav.distToNext), remaining: Math.round(nav.remaining), etaS: Math.round(etaS),
    turn: t ? { c: t.c, txt: turnText(t), dist: Math.round(t.dist) } : null,
    offRoute: nav.offRoute, offDist: Math.round(nav.offDist), guard: nav.guard ? { level: nav.guard.level, d: Math.round(nav.guard.d) } : null,
    detour: !!nav.detour,
  };
}

async function publish() {
  pending = false;
  lastPub = Date.now();
  const p = nav.pos;
  const ok = await team.publishState({
    online: true, pos: p ?? undefined, hd: Math.round(nav.heading), spd: +(nav.mode === 'sim' ? (nav.settings.simKmh / 3.6) * nav.mult : nav.speedMps).toFixed(1),
    acc: Math.round(nav.accuracy), bat: battery?.level, charging: battery?.charging, nav: navState(),
  });
  if (!ok && p && nav.mode === 'live') buffer.push([Date.now(), +p[0].toFixed(6), +p[1].toFixed(6)]);
  if (buffer.length > 50000) buffer.splice(0, buffer.length - 50000);
}

function maybePublish() {
  if (!team.settings) return;
  const p = nav.pos ? `${nav.pos[0].toFixed(6)},${nav.pos[1].toFixed(6)}` : null;
  const moving = nav.mode !== 'off';
  const due = moving ? 1000 : 30000;
  if (p !== lastPos && moving && Date.now() - lastPub >= 1000) { lastPos = p; void publish(); return; }
  if (!pending && Date.now() - lastPub >= due) { pending = true; setTimeout(() => void publish(), 50); }
}

async function flushBuffer() {
  if (!buffer.length || team.status !== 'online' || !team.settings) return;
  const pts = buffer.splice(0, buffer.length);
  for (let i = 0; i < pts.length; i += 1000) await team.send({ type: 'track', from: team.settings.deviceId, pts: pts.slice(i, i + 1000) });
}

export function startTelemetry() {
  (navigator as any).getBattery?.().then((b: any) => {
    const upd = () => { battery = { level: Math.round(b.level * 100), charging: b.charging }; };
    upd(); b.addEventListener('levelchange', upd); b.addEventListener('chargingchange', upd);
  }).catch(() => undefined);
  nav.subscribe(maybePublish);
  let wasOnline = false;
  team.subscribe(() => {
    const on = team.status === 'online';
    if (on && !wasOnline) { void publish(); void flushBuffer(); }
    wasOnline = on;
  });
  setInterval(maybePublish, 5000);
}
