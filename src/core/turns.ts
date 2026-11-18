/**
 * Turn-by-turn maneuvers. Stored compactly with each cached road leg:
 * i = index of the maneuver point inside the leg's coordinates.
 */
export type TurnCode =
  | 'straight' | 'slight-right' | 'right' | 'sharp-right' | 'uturn' | 'sharp-left' | 'left' | 'slight-left'
  | 'roundabout' | 'keep-left' | 'keep-right' | 'merge' | 'ramp-left' | 'ramp-right' | 'exit-left' | 'exit-right';
export interface Turn { i: number; c: TurnCode; n?: string; x?: number; /** ready-made instruction (Google) */ txt?: string }

const MOD: Record<string, TurnCode> = {
  'uturn': 'uturn', 'sharp right': 'sharp-right', 'right': 'right', 'slight right': 'slight-right',
  'straight': 'straight', 'slight left': 'slight-left', 'left': 'left', 'sharp left': 'sharp-left',
};

/** OSRM step → Turn (null for depart/arrive and silent "new name" continues). */
export function osrmTurn(step: any, i: number): Turn | null {
  const m = step.maneuver ?? {};
  const t: string = m.type ?? '';
  const mod: string = m.modifier ?? 'straight';
  const name = [step.name, step.ref].filter(Boolean).join(' · ') || undefined;
  let c: TurnCode | null = null;
  switch (t) {
    case 'depart': case 'arrive': return null;
    case 'new name': case 'notification': return null;
    case 'continue': c = mod === 'straight' ? null : MOD[mod] ?? null; break;
    case 'turn': case 'end of road': c = MOD[mod] ?? 'straight'; break;
    case 'fork': c = mod.includes('left') ? 'keep-left' : mod.includes('right') ? 'keep-right' : null; break;
    case 'merge': c = 'merge'; break;
    case 'on ramp': c = mod.includes('left') ? 'ramp-left' : 'ramp-right'; break;
    case 'off ramp': c = mod.includes('left') ? 'exit-left' : 'exit-right'; break;
    case 'roundabout': case 'rotary': case 'roundabout turn': c = 'roundabout'; break;
    case 'exit roundabout': case 'exit rotary': return null;
    default: c = MOD[mod] ?? null;
  }
  if (!c || (c === 'straight' && t !== 'end of road')) return null;
  return { i, c, n: name, x: m.exit };
}

/** Valhalla maneuver type → Turn. */
const VAL: Record<number, TurnCode> = {
  9: 'slight-right', 10: 'right', 11: 'sharp-right', 12: 'uturn', 13: 'uturn', 14: 'sharp-left', 15: 'left', 16: 'slight-left',
  18: 'ramp-right', 19: 'ramp-left', 20: 'exit-right', 21: 'exit-left', 23: 'keep-right', 24: 'keep-left',
  25: 'merge', 26: 'roundabout', 37: 'merge', 38: 'merge',
};
export function valhallaTurn(m: any): Turn | null {
  const c = VAL[m.type];
  if (!c) return null;
  return { i: m.begin_shape_index ?? 0, c, n: (m.street_names ?? []).join(' · ') || undefined, x: m.roundabout_exit_count };
}

const ord = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

export function turnText(t: { c: TurnCode; n?: string; x?: number; txt?: string }): string {
  if (t.txt) return t.txt;
  const onto = t.n ? ` onto ${t.n}` : '';
  switch (t.c) {
    case 'left': return `Turn left${onto}`;
    case 'right': return `Turn right${onto}`;
    case 'slight-left': return `Bear left${onto}`;
    case 'slight-right': return `Bear right${onto}`;
    case 'sharp-left': return `Sharp left${onto}`;
    case 'sharp-right': return `Sharp right${onto}`;
    case 'uturn': return `Make a U-turn${onto}`;
    case 'roundabout': return `At the roundabout, take the ${t.x ? ord(t.x) + ' ' : ''}exit${onto}`;
    case 'keep-left': return `Keep left${onto}`;
    case 'keep-right': return `Keep right${onto}`;
    case 'merge': return `Merge${onto}`;
    case 'ramp-left': case 'ramp-right': return `Take the ramp${onto}`;
    case 'exit-left': case 'exit-right': return `Take the exit${onto}`;
    default: return `Continue${onto}`;
  }
}
