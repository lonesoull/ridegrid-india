import { engine } from '../core/engine';
import type { LngLat } from '../core/geo';
import { isExpedition } from '../core/terms';
import { createTrip, switchTrip } from '../core/trips';
import type { StopTuple } from '../core/db';
import { nav } from '../nav/navigator';
import { myFix, fixProblem } from '../nav/directions';
import { sounds, say } from '../nav/audio';
import { pack, unpack } from './crypto';
import { team, type TeamEvent } from './team';
import { ui, toast } from '../ui/state';

const PART = 60000; // characters per route part (public relays limit message size)

/** Send the planned route to every team device (they are asked before it's loaded). */
export async function pushRoute() {
  const s = team.settings;
  if (!s) throw new Error('Join a team first');
  if (!engine.stops.length) throw new Error('No route to send');
  const data = await pack({ title: engine.trip!.name, kind: isExpedition() ? 'expedition' : 'daily', stops: engine.snapshot() });
  const parts = Math.ceil(data.length / PART);
  const routeId = `${s.deviceId}-${Date.now().toString(36)}`;
  await team.send({ type: 'route-offer', from: s.deviceId, name: s.name, routeId, title: engine.trip!.name, kind: isExpedition() ? 'expedition' : 'daily', count: engine.stops.length, parts });
  for (let i = 0; i < parts; i++) await team.send({ type: 'route-part', from: s.deviceId, routeId, i, data: data.slice(i * PART, (i + 1) * PART) });
  return { parts, count: engine.stops.length };
}

export interface RouteOffer { from: string; name: string; title: string; kind: 'expedition' | 'daily'; stops: StopTuple[] }

export async function acceptRoute(o: RouteOffer, how: 'new' | 'replace') {
  const stops = o.stops.map((t) => ({ id: t[0], lng: t[1], lat: t[2], name: t[3] }));
  if (how === 'new') {
    const t = await createTrip(`${o.title} (from ${o.name})`, undefined, o.kind);
    await switchTrip(t.id);
  }
  await engine.replaceAll(stops);
}

/** Broadcast an SOS with exact position to every team device. */
export async function sendSos(msg?: string) {
  const s = team.settings;
  if (!s) throw new Error('Join a team first');
  let pos = nav.pos, acc = nav.accuracy;
  if (!pos) { const f = await myFix(); if (fixProblem(f)) throw new Error(fixProblem(f)!); pos = f.p; acc = f.acc; }
  await team.send({ type: 'sos', from: s.deviceId, name: s.name, pos: pos as LngLat, acc, t: Date.now(), msg });
  return pos;
}

let alarmTimer: ReturnType<typeof setInterval> | null = null;
export function stopAlarm() { if (alarmTimer) clearInterval(alarmTimer); alarmTimer = null; }

/** React to team events: SOS alarm, SOS acknowledgements, route offers, stops logged by others. */
export function startTeamEvents() {
  const parts = new Map<string, { offer: Extract<TeamEvent, { type: 'route-offer' }>; got: string[] }>();
  team.onEvent(async (e) => {
    switch (e.type) {
      case 'sos':
        ui.set({ sos: e });
        stopAlarm();
        sounds.offRoute(); say(`S O S from ${e.name}`);
        alarmTimer = setInterval(() => { sounds.offRoute(); }, 2500);
        break;
      case 'sos-ack':
        if (e.to === team.settings?.deviceId) { toast(`${e.name} received your SOS and is responding`); say(`${e.name} is responding`); }
        break;
      case 'stop':
        toast(`${e.name}: ${e.label}${e.place ? ` at ${e.place}` : ''}`);
        break;
      case 'route-offer':
        parts.set(e.routeId, { offer: e, got: new Array(e.parts) });
        break;
      case 'route-part': {
        const p = parts.get(e.routeId);
        if (!p) return;
        p.got[e.i] = e.data;
        if (p.got.filter((x) => x !== undefined).length === p.offer.parts) {
          parts.delete(e.routeId);
          try {
            const d = await unpack<{ title: string; kind: 'expedition' | 'daily'; stops: StopTuple[] }>(p.got.join(''));
            ui.set({ routeOffer: { from: p.offer.from, name: p.offer.name, title: d.title, kind: d.kind, stops: d.stops } });
            sounds.arrival();
          } catch { toast('A route from the team arrived damaged — ask them to send it again', 'error'); }
        }
        break;
      }
    }
  });
}
