import { useEffect, useRef, useState } from 'react';
import { altAz, bodies, lst } from './sky';
import { nav } from '../nav/navigator';
import { mapCtl } from '../ui/App';

/** Star chart (OsmAnd astronomy): stars, constellations, planets, Moon and Sun for your place and time; drag, zoom or point the phone at the sky. */
type Sky = { stars: [number, number, number, string][]; lines: [number, number][][][]; cons: [number, number, string][] };
let skyData: Promise<Sky> | null = null;
const loadSky = () => (skyData ??= fetch(`${import.meta.env.BASE_URL}sky/sky.json`).then((r) => r.json()));
const R = Math.PI / 180;

export function StarChart({ onClose }: { onClose: () => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const view = useRef({ az: 180, alt: 35, fov: 100 });
  const [sky, setSky] = useState<Sky | null>(null);
  const [ar, setAr] = useState(false);
  const [hours, setHours] = useState(0);
  const [picked, setPicked] = useState('');
  const pts = useRef<{ x: number; y: number; label: string }[]>([]);
  useEffect(() => { void loadSky().then(setSky); }, []);
  const where = nav.pos ?? (mapCtl ? [mapCtl.map.getCenter().lng, mapCtl.map.getCenter().lat] : [77.6, 13]);

  // phone pointing (AR)
  useEffect(() => {
    if (!ar) return;
    const on = (e: DeviceOrientationEvent) => {
      const az = (e as any).webkitCompassHeading ?? (e.alpha !== null ? 360 - e.alpha : null);
      if (az === null || e.beta === null) return;
      view.current.az = az; view.current.alt = Math.max(-30, Math.min(90, e.beta - 90));
      draw();
    };
    const ask = (DeviceOrientationEvent as any).requestPermission;
    if (ask) void ask().catch(() => {});
    window.addEventListener('deviceorientationabsolute' as any, on); window.addEventListener('deviceorientation', on);
    return () => { window.removeEventListener('deviceorientationabsolute' as any, on); window.removeEventListener('deviceorientation', on); };
  }, [ar, sky, hours]);

  const draw = () => {
    const c = cv.current; if (!c || !sky) return;
    const W = (c.width = c.clientWidth * devicePixelRatio), H = (c.height = c.clientHeight * devicePixelRatio);
    const g = c.getContext('2d')!;
    const when = new Date(Date.now() + hours * 3600000), L = lst(when, where[0]), lat = where[1];
    const { az: az0, alt: alt0, fov } = view.current;
    const k = (Math.min(W, H) / 2) / Math.tan((fov / 4) * R);
    // horizontal (alt, az) → screen, stereographic around the view direction
    const proj = (alt: number, az: number) => {
      const x = Math.cos(alt * R) * Math.sin(az * R), y = Math.cos(alt * R) * Math.cos(az * R), z = Math.sin(alt * R);
      const ca = Math.cos(az0 * R), sa = Math.sin(az0 * R), ce = Math.cos(alt0 * R), se = Math.sin(alt0 * R);
      const x1 = x * ca - y * sa, y1 = x * sa + y * ca;           // rotate azimuth to the view
      const fwd = y1 * ce + z * se, up = -y1 * se + z * ce;        // tilt to the view altitude
      if (fwd < -0.2) return null;
      const s = k * 2 / (1 + fwd);
      return { x: W / 2 + x1 * s / 2, y: H / 2 - up * s / 2 };
    };
    const night = when.getTime() && true;
    g.fillStyle = night ? '#050a1a' : '#000'; g.fillRect(0, 0, W, H);
    pts.current = [];
    const sz = devicePixelRatio;
    // constellation lines
    g.strokeStyle = 'rgba(120,160,255,.35)'; g.lineWidth = sz;
    for (const con of sky.lines) for (const line of con) {
      g.beginPath(); let started = false;
      for (const [ra, dec] of line) { const h = altAz(ra, dec, lat, L); const p = proj(h.alt, h.az); if (!p) { started = false; continue; } if (started) g.lineTo(p.x, p.y); else { g.moveTo(p.x, p.y); started = true; } }
      g.stroke();
    }
    // stars
    for (const [ra, dec, mag, name] of sky.stars) {
      if (mag > 6 - (fov > 120 ? 1.5 : 0)) continue;
      const h = altAz(ra, dec, lat, L); const p = proj(h.alt, h.az); if (!p) continue;
      const r = Math.max(0.5, (5.5 - mag) * 0.6) * sz;
      g.fillStyle = h.alt < 0 ? 'rgba(255,255,255,.25)' : '#fff';
      g.beginPath(); g.arc(p.x, p.y, r, 0, 2 * Math.PI); g.fill();
      if (name) { g.fillStyle = 'rgba(200,220,255,.8)'; g.font = `${11 * sz}px system-ui`; g.fillText(name, p.x + r + 3, p.y + 3); pts.current.push({ x: p.x, y: p.y, label: `${name} · magnitude ${mag} · ${h.alt > 0 ? `${Math.round(h.alt)}° up` : 'below horizon'}` }); }
    }
    // constellation names
    g.fillStyle = 'rgba(140,170,255,.6)'; g.font = `${10 * sz}px system-ui`;
    for (const [ra, dec, n] of sky.cons) { const h = altAz(ra, dec, lat, L); const p = proj(h.alt, h.az); if (p && fov < 140) g.fillText(n.toUpperCase(), p.x, p.y); }
    // Sun, Moon, planets
    for (const b of bodies(when)) {
      const h = altAz(b.ra, b.dec, lat, L); const p = proj(h.alt, h.az); if (!p) continue;
      const r = (b.name === 'Sun' || b.name === 'Moon' ? 9 : 4) * sz;
      g.fillStyle = b.color; g.beginPath(); g.arc(p.x, p.y, r, 0, 2 * Math.PI); g.fill();
      g.fillStyle = '#ffd54f'; g.font = `bold ${12 * sz}px system-ui`; g.fillText(b.name, p.x + r + 3, p.y - 3);
      pts.current.push({ x: p.x, y: p.y, label: `${b.name} · ${h.alt > 0 ? `${Math.round(h.alt)}° up, ${Math.round(h.az)}° from north` : 'below the horizon'}` });
    }
    // ground and horizon
    g.fillStyle = 'rgba(20,40,20,.55)'; g.beginPath();
    let first = true;
    for (let az = 0; az <= 360; az += 3) { const p = proj(0, az); if (!p) { first = true; continue; } if (first) { g.moveTo(p.x, p.y); first = false; } else g.lineTo(p.x, p.y); }
    g.strokeStyle = '#3c6'; g.lineWidth = 2 * sz; g.stroke();
    g.fillStyle = '#6f6'; g.font = `bold ${14 * sz}px system-ui`;
    for (const [lbl, az] of [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]] as const) { const p = proj(0, az); if (p) g.fillText(lbl, p.x - 6 * sz, p.y + 18 * sz); }
  };
  useEffect(draw, [sky, hours]);

  // drag / zoom
  useEffect(() => {
    const c = cv.current; if (!c) return;
    let last: { x: number; y: number } | null = null;
    const down = (e: PointerEvent) => { last = { x: e.clientX, y: e.clientY }; };
    const move = (e: PointerEvent) => { if (!last || ar) return; const v = view.current, f = v.fov / c.clientWidth; v.az = (v.az - (e.clientX - last.x) * f + 360) % 360; v.alt = Math.max(-30, Math.min(90, v.alt + (e.clientY - last.y) * f)); last = { x: e.clientX, y: e.clientY }; draw(); };
    const up = (e: PointerEvent) => {
      if (last && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 4) {
        const x = (e.clientX - c.getBoundingClientRect().left) * devicePixelRatio, y = (e.clientY - c.getBoundingClientRect().top) * devicePixelRatio;
        const near = pts.current.reduce<{ d: number; label: string } | null>((b, p) => { const d = Math.hypot(p.x - x, p.y - y); return d < 40 * devicePixelRatio && (!b || d < b.d) ? { d, label: p.label } : b; }, null);
        setPicked(near?.label ?? '');
      }
      last = null;
    };
    const wheel = (e: WheelEvent) => { e.preventDefault(); view.current.fov = Math.max(20, Math.min(180, view.current.fov * (e.deltaY > 0 ? 1.1 : 0.9))); draw(); };
    c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('wheel', wheel, { passive: false });
    return () => { c.removeEventListener('pointerdown', down); c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', up); c.removeEventListener('wheel', wheel); };
  }, [sky, ar, hours]);

  return (
    <div className="starchart">
      <canvas ref={cv} />
      <div className="skybar glass">
        <button onClick={onClose}>✕</button>
        <button className={ar ? 'on' : ''} onClick={() => setAr(!ar)}>📱 {ar ? 'Pointing on' : 'Point at the sky'}</button>
        <button onClick={() => { view.current.fov = Math.max(20, view.current.fov * 0.75); draw(); }}>＋</button>
        <button onClick={() => { view.current.fov = Math.min(180, view.current.fov * 1.33); draw(); }}>－</button>
        <label className="skytime">{hours === 0 ? 'Now' : `${hours > 0 ? '+' : ''}${hours} h`}<input type="range" min={-12} max={12} value={hours} onChange={(e) => setHours(+e.target.value)} /></label>
      </div>
      {picked && <div className="skypick glass">{picked}</div>}
    </div>
  );
}
