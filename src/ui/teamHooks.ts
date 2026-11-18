import { useSyncExternalStore } from 'react';
import { team, type Peer } from '../team/team';
import { sounds } from '../nav/audio';
import { mapCtl } from './App';

/** Re-render on team changes (once per frame) and keep the map's team layer current. */
const subs = new Set<() => void>();
let raf = 0;
const alerted = new Map<string, string>();
team.subscribe(() => {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    subs.forEach((f) => f());
    const list = [...team.peers.values()];
    mapCtl?.setPeers(list);
    // a riding phone going off-route / too close to a planned road also beeps on the other devices
    for (const p of list) {
      const a = p.nav?.guard && p.nav.guard.level !== 'warn' ? 'guard' : p.nav?.offRoute ? 'off' : '';
      if (a && alerted.get(p.id) !== a) sounds.offRoute();
      alerted.set(p.id, a);
    }
  });
});
export function useTeam() {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => team.version);
}

/** The device to mirror on this one: a riding primary phone first, else any riding device. */
export function riderToMirror(): Peer | null {
  const riding = [...team.peers.values()].filter((p) => p.online && p.nav && Date.now() - p.lastSeen < 120000);
  return riding.find((p) => p.role === 'primary') ?? riding[0] ?? null;
}
