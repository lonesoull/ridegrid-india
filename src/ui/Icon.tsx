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
  camera: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  mic: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4',
  rec: 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12z',
  minus: 'M5 12h14',
  lock: 'M5 11h14v11H5zM7 11V7a5 5 0 0 1 10 0v4',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5',
  back: 'M19 12H5M12 19l-7-7 7-7',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  chevdown: 'm6 9 6 6 6-6',
  chevup: 'm18 15-6-6-6 6',
  chevright: 'm9 18 6-6-6-6',
  layers: 'm12 2 10 5-10 5L2 7l10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
  pin: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0zM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  fuel: 'M3 22h12M4 9h10M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.83a2 2 0 0 0-.59-1.42L18 5',
  food: 'M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
  cash: 'M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 12h.01M18 12h.01',
  bed: 'M2 4v16M2 8h18a2 2 0 0 1 2 2v10M2 17h20M6 8v9',
  hospital: 'M3 3h18v18H3zM12 8v8M8 12h8',
  coffee: 'M17 8h1a4 4 0 1 1 0 8h-1M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4zM6 2v2M10 2v2M14 2v2',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  star: 'm12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  parking: 'M4 3h16v18H4zM9 17V7h4a3 3 0 0 1 0 6H9',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  map: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4zM8 2v16M16 6v16',
  volume: 'M11 5 6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07',
  cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 16v-4M12 8h.01',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15zM6.5 17A2.5 2.5 0 0 0 4 19.5 2.5 2.5 0 0 0 6.5 22H20v-5',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  swap: 'M7 16V4M3 8l4-4 4 4M17 8v12M21 16l-4 4-4-4',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
  bluetooth: 'm7 7 10 10-5 5V2l5 5L7 17',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  route: 'M3 17a3 3 0 1 0 6 0 3 3 0 0 0-6 0zM15 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0zM9 17h6a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6',
  more: 'M12 6.5a1 1 0 1 0 0-.01M12 12.5a1 1 0 1 0 0-.01M12 18.5a1 1 0 1 0 0-.01',
};
const FILLED = new Set(['play', 'pause', 'stop', 'sim', 'directions', 'compass', 'gmaps', 'rec']);

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
