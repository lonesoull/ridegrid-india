import type { TurnCode } from '../core/turns';

/** Crisp inline SVG icons (emoji/Unicode symbols render inconsistently on Windows). */
const P: Record<string, string> = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  plus: 'M12 5v14M5 12h14',
  insert: 'M4 12h6m4 0h6M12 4v16',
  hand: 'M18 11V6a2 2 0 0 0-4 0v5m0-6V4a2 2 0 0 0-4 0v7m0-5.5a2 2 0 0 0-4 0V14m12-3a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15',
  fit: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  tilt: 'm8 3 4 8 5-5 5 15H2L8 3z',
  compass: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.24 5.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z',
  locate: 'M12 2v3M12 19v3M2 12h3M19 12h3M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  bike: 'M5 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM5 15l4-6h5l3 6M12 9l-1-3H8M14 9h3l2 6',
  directions: 'M21.71 11.29l-9-9a1 1 0 0 0-1.42 0l-9 9a1 1 0 0 0 0 1.42l9 9a1 1 0 0 0 1.42 0l9-9a1 1 0 0 0 0-1.42zM14 14.5V12h-4v3H8v-4a1 1 0 0 1 1-1h5V7.5l3.5 3.5z',
  play: 'M7 4v16l13-8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  stop: 'M6 6h12v12H6z',
  sim: 'M4 5v14l8-7zM12 5v14l8-7z',
  target: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  gmaps: 'M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z',
  traffic: 'M9 2h6a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM12 7a1.5 1.5 0 1 0 0-.01M12 12a1.5 1.5 0 1 0 0-.01M12 17a1.5 1.5 0 1 0 0-.01',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
};
const FILLED = new Set(['play', 'pause', 'stop', 'sim', 'directions', 'compass', 'gmaps']);

export function Icon({ name, size = 22, className }: { name: keyof typeof P | string; size?: number; className?: string }) {
  const filled = FILLED.has(name);
  return (
    <svg className={`ico ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={P[name] ?? ''} fillRule="evenodd" />
    </svg>
  );
}

const ANG: Partial<Record<TurnCode, number>> = {
  straight: 0, 'slight-right': 45, right: 90, 'sharp-right': 135, 'slight-left': -45, left: -90, 'sharp-left': -135,
  'keep-right': 30, 'keep-left': -30, merge: 0, 'ramp-right': 40, 'ramp-left': -40, 'exit-right': 40, 'exit-left': -40,
};

/** Big maneuver arrow for the turn banner. */
export function TurnIcon({ c, size = 48 }: { c: TurnCode; size?: number }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (c === 'uturn') {
    return <svg width={size} height={size} viewBox="0 0 48 48"><path {...common} d="M30 42V20a8 8 0 0 0-16 0v10" /><path {...common} d="m8 24 6 7 6-7" /></svg>;
  }
  if (c === 'roundabout') {
    return <svg width={size} height={size} viewBox="0 0 48 48"><circle {...common} cx="24" cy="22" r="8" /><path {...common} d="M24 44V30M30 16l8-8M31 8h7v7" /></svg>;
  }
  const a = ((ANG[c] ?? 0) * Math.PI) / 180;
  const ex = 24 + Math.sin(a) * 16, ey = 22 - Math.cos(a) * 16;
  const hx = (d: number) => ex + Math.sin(a + d) * -8, hy = (d: number) => ey - Math.cos(a + d) * -8;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48">
      {(c === 'keep-left' || c === 'keep-right') && <path fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="5" strokeLinecap="round" d={`M24 22 L${24 - Math.sin(a) * 16} 6`} />}
      <path {...common} d={`M24 44 V22 L${ex.toFixed(1)} ${ey.toFixed(1)}`} />
      <path {...common} d={`M${hx(0.6).toFixed(1)} ${hy(0.6).toFixed(1)} L${ex.toFixed(1)} ${ey.toFixed(1)} L${hx(-0.6).toFixed(1)} ${hy(-0.6).toFixed(1)}`} />
    </svg>
  );
}
