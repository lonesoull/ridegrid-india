import { useEffect, useState } from 'react';
import { db, type Ride } from '../core/db';
import { engine } from '../core/engine';
import { fmtKm, haversine, type LngLat } from '../core/geo';
import { download, safeName } from '../io/exporters';
import { mapCtl } from '../ui/App';
import { act, toast, ui } from '../ui/state';
import { recorder } from './recorder';
import { analyse, colouredTrack, gpxOf, importGpxTrack, saveLineAsTrack, showTrack, trackPoints, joinTracks, splitTrack, snapTrack, type TrackStats, type ColourBy } from './trackTools';
import type { RidePoint } from '../core/db';
import { device } from '../route/device';

/** Tracks shown on the map together (OsmAnd: several visible tracks), each in its colouring. */
const visible = new Map<string, GeoJSON.Feature[]>();
let colourBy: ColourBy = 'speed';
const SOLID = ['#e53935', '#1e88e5', '#43a047', '#8e24aa', '#fb8c00', '#00897b'];
function redraw() { if (mapCtl) showTrack(mapCtl, visible.size ? { type: 'FeatureCollection', features: [...visible.values()].flat() } : null); }
async function toggleVisible(r: Ride, pts?: RidePoint[]) {
  if (visible.has(r.id)) { visible.delete(r.id); redraw(); return false; }
  const p = pts ?? (await trackPoints(r.id));
  visible.set(r.id, colouredTrack(p, colourBy, SOLID[visible.size % SOLID.length]).features);
  redraw();
  return true;
}

const hm = (s: number) => `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Daily "Tracks" (OsmAnd trip recording + My tracks + Plan a route / measure). */
export function TracksTab() {
  const [, tick] = useState(0);
  const [rides, setRides] = useState<Ride[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const reload = async () => {
    const daily = new Set((await db.trips.toArray()).filter((t) => t.kind === 'daily').map((t) => t.id));
    setRides((await db.rides.toArray()).filter((r) => daily.has(r.tripId) && !r.simulated).sort((a, b) => b.startedAt - a.startedAt));
  };
  useEffect(() => { void reload(); const f = () => { tick((x) => x + 1); }; recorder.listeners.add(f); return () => { recorder.listeners.delete(f); }; }, []);
  const folders = [...new Set(rides.map((r) => r.folder || 'Navigation rides'))].sort();
  const s = recorder.s;
  return (
    <div className="stack">
      <section>
        <h3>Track recording</h3>
        {recorder.on
          ? <p>● <b>Recording</b> · {fmtKm(recorder.distM)} · {recorder.points} points · since {new Date(recorder.startedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</p>
          : <p className="muted">Records your ride without navigating (also in the background on Android). Navigation rides are logged automatically.</p>}
        <button className={recorder.on ? 'danger' : 'primary'} onClick={() => act(null, () => (recorder.on ? recorder.stop() : recorder.start())).then(reload)}>{recorder.on ? '■ Stop & save' : '● Start recording'}</button>
        <details>
          <summary className="muted">Recording settings (GPS filters)</summary>
          <label className="field">Save a point every <b>{s.minDistM} m</b><input type="range" min={1} max={50} value={s.minDistM} onChange={(e) => void recorder.setSettings({ minDistM: +e.target.value })} /></label>
          <label className="field">Ignore fixes worse than <b>±{s.maxAccM} m</b><input type="range" min={10} max={100} step={5} value={s.maxAccM} onChange={(e) => void recorder.setSettings({ maxAccM: +e.target.value })} /></label>
          <label className="field">Ignore below <b>{s.minSpeedKmh} km/h</b> (removes standing jitter)<input type="range" min={0} max={10} value={s.minSpeedKmh} onChange={(e) => void recorder.setSettings({ minSpeedKmh: +e.target.value })} /></label>
          <label className="field">New track after a gap of <b>{s.splitMin} min</b><input type="range" min={5} max={120} step={5} value={s.splitMin} onChange={(e) => void recorder.setSettings({ splitMin: +e.target.value })} /></label>
          <label className="field">Save into folder<input defaultValue={s.folder} onBlur={(e) => void recorder.setSettings({ folder: e.target.value.trim() || 'Rides' })} /></label>
        </details>
      </section>

      <Measure onSaved={reload} />

      <section>
        <h3>My tracks</h3>
        <div className="btns sm">
          <label className="field">Colour tracks by
            <select value={colourBy} onChange={(e) => { colourBy = e.target.value as ColourBy; const ids = [...visible.keys()]; visible.clear(); void Promise.all(rides.filter((r) => ids.includes(r.id)).map((r) => toggleVisible(r))).then(() => tick((x) => x + 1)); }}>
              <option value="speed">Speed</option><option value="altitude">Altitude</option><option value="slope">Slope (up / down)</option><option value="solid">One colour per track</option>
            </select>
          </label>
          {visible.size > 0 && <button onClick={() => { visible.clear(); redraw(); tick((x) => x + 1); }}>Hide all from map ({visible.size})</button>}
          {sel.size >= 2 && <button onClick={() => act('Joining…', async () => { await joinTracks(rides.filter((r) => sel.has(r.id)), engine.trip!.id); setSel(new Set()); await reload(); toast('Joined into a new track'); })}>Join {sel.size} selected</button>}
        </div>
        <label className="photo-btn">
          <input type="file" accept=".gpx,.kml,application/gpx+xml,application/vnd.google-earth.kml+xml" multiple hidden onChange={(e) => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; void act('Importing…', async () => { for (const f of fs) await importGpxTrack(f, engine.trip!.id, 'Imported'); await reload(); toast(`${fs.length} track(s) imported`); }); }} />
          ⬆ Import GPX / KML tracks
        </label>
        {!rides.length && <p className="muted">No tracks yet.</p>}
        {folders.map((f) => (
          <details key={f} open>
            <summary><b>📁 {f}</b> <span className="muted">({rides.filter((r) => (r.folder || 'Navigation rides') === f).length} · {fmtKm(rides.filter((r) => (r.folder || 'Navigation rides') === f).reduce((m, r) => m + r.distM, 0))})</span></summary>
            {rides.filter((r) => (r.folder || 'Navigation rides') === f).map((r) => (
              <div key={r.id} className="trackrow">
                <input type="checkbox" aria-label="Select" checked={sel.has(r.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSel(n); }} />
                <button className="link result" onClick={() => setOpen(open === r.id ? null : r.id)}>
                  <b>{r.name}</b><div className="muted">{new Date(r.startedAt).toLocaleString('en-IN')} · {fmtKm(r.distM)}{r.source === 'import' ? ' · imported' : r.source === 'plan' ? ' · planned' : ''}</div>
                </button>
                {visible.has(r.id) && <span className="pill">on map</span>}
                {open === r.id && <TrackDetail r={r} onChange={() => { void reload(); tick((x) => x + 1); }} />}
              </div>
            ))}
          </details>
        ))}
      </section>
    </div>
  );
}

function TrackDetail({ r, onChange }: { r: Ride; onChange: () => void }) {
  const [st, setSt] = useState<TrackStats | null>(null);
  useEffect(() => { void trackPoints(r.id).then((p) => setSt(analyse(p))); }, [r.id]);
  if (!st) return <p className="muted">Loading…</p>;
  const show = async () => {
    if (!mapCtl || st.pts.length < 2) return;
    if (!(await toggleVisible(r, st.pts))) { onChange(); return; }
    const xs = st.pts.map((p) => p[1]), ys = st.pts.map((p) => p[2]);
    mapCtl.map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 60 });
    ui.set({ drawer: false });
  };
  const best = st.splits.length ? st.splits.reduce((a, b) => (b.s < a.s ? b : a)) : null;
  return (
    <div className="trackdetail">
      <div className="grid3">
        <div><b>{fmtKm(st.distM)}</b><span className="muted">distance</span></div>
        <div><b>{hm(st.durS)}</b><span className="muted">total time</span></div>
        <div><b>{hm(st.movingS)}</b><span className="muted">moving</span></div>
        <div><b>{st.avgKmh.toFixed(1)}</b><span className="muted">avg km/h</span></div>
        <div><b>{st.maxKmh.toFixed(0)}</b><span className="muted">max km/h</span></div>
        <div><b>{Number.isFinite(st.minAlt) ? `↗${Math.round(st.climbM)} ↘${Math.round(st.descentM)}` : '—'}</b><span className="muted">climb / descent m</span></div>
      </div>
      <Graph data={st.speed} label="Speed (km/h)" color="#1e88e5" />
      {st.alt.length > 2 && <Graph data={st.alt} label={`Altitude ${Math.round(st.minAlt)}–${Math.round(st.maxAlt)} m`} color="#8d6e63" />}
      {st.splits.length > 0 && <details><summary className="muted">Splits per km{best ? ` (fastest: km ${best.km}, ${mmss(best.s)})` : ''}</summary>
        <div className="splits">{st.splits.map((x) => <span key={x.km}>km {x.km}: <b>{mmss(x.s)}</b> ({(3600 / x.s).toFixed(0)} km/h)</span>)}</div></details>}
      <div className="btns sm">
        <button onClick={() => void show()}>{visible.has(r.id) ? 'Hide from map' : 'Show on map'}</button>
        <button onClick={() => act('Matching to roads…', async () => { await snapTrack(r, async (pts) => (await device.route(pts)).map((l) => l?.coords ?? null)); onChange(); toast('Saved a copy that follows the roads'); })}>Snap to roads</button>
        <button onClick={() => act(null, async () => { const k = prompt(`Split at which km? (0–${(st.distM / 1000).toFixed(1)})`); if (k) { await splitTrack(r, +k); onChange(); toast('Split into two tracks'); } })}>Split</button>
        <button onClick={() => download(`${safeName(r.name)}.gpx`, new Blob([gpxOf(r, st.pts)], { type: 'application/gpx+xml' }))}>Export GPX</button>
        <button onClick={() => { const n = prompt('Name', r.name); if (n) void db.rides.update(r.id, { name: n }).then(onChange); }}>Rename</button>
        <button onClick={() => { const f = prompt('Move to folder', r.folder ?? 'Rides'); if (f) void db.rides.update(r.id, { folder: f }).then(onChange); }}>Folder</button>
        <button className="danger" onClick={() => confirm(`Delete “${r.name}”?`) && void db.transaction('rw', db.rides, db.rideChunks, async () => { await db.rideChunks.where('rideId').equals(r.id).delete(); await db.rides.delete(r.id); }).then(onChange)}>Delete</button>
      </div>
    </div>
  );
}

function Graph({ data, label, color }: { data: { s: number; v: number }[]; label: string; color: string }) {
  if (data.length < 2) return null;
  const W = 320, H = 70, maxS = data[data.length - 1].s || 1, min = Math.min(...data.map((d) => d.v)), max = Math.max(...data.map((d) => d.v)), span = Math.max(1, max - min);
  const pts = data.map((d) => `${(d.s / maxS) * W},${H - ((d.v - min) / span) * (H - 6) - 3}`).join(' ');
  return (
    <figure className="graph"><figcaption className="muted">{label}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}><polyline points={pts} fill="none" stroke={color} strokeWidth="2" /></svg>
    </figure>
  );
}

/** Plan / measure (OsmAnd "Plan a route"): tap points; straight or along roads; save as a track or as this ride's stops. */
function Measure({ onSaved }: { onSaved: () => void }) {
  const [on, setOn] = useState(false);
  const [pts, setPts] = useState<LngLat[]>([]);
  const [line, setLine] = useState<LngLat[]>([]);
  const [roads, setRoads] = useState(true);
  useEffect(() => {
    if (!on || !mapCtl) return;
    const m = mapCtl.map;
    const before = ui.get().tapMode;
    ui.set({ tapMode: 'off' });
    const click = (e: any) => setPts((p) => [...p, [e.lngLat.lng, e.lngLat.lat]]);
    m.on('click', click);
    return () => { m.off('click', click); ui.set({ tapMode: before }); };
  }, [on]);
  useEffect(() => {
    void (async () => {
      if (pts.length < 2) { setLine(pts); return; }
      if (!roads) { setLine(pts); return; }
      const legs = await device.route(pts).catch(() => null);
      if (legs?.every(Boolean)) { setLine(legs.flatMap((l) => l!.coords)); return; }
      const j = await fetch(`https://router.project-osrm.org/route/v1/driving/${pts.map((p) => p.join(',')).join(';')}?overview=full&geometries=geojson`).then((r) => r.json()).catch(() => null);
      setLine(j?.routes?.[0]?.geometry?.coordinates ?? pts);
    })();
  }, [pts, roads]);
  useEffect(() => { if (mapCtl) showTrack(mapCtl, line.length > 1 ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { v: 60 }, geometry: { type: 'LineString', coordinates: line } }] } : null); }, [line]);
  const dist = line.slice(1).reduce((m, p, i) => m + haversine(line[i], p), 0);
  return (
    <section>
      <h3>Plan a route / measure</h3>
      {!on ? <button onClick={() => { setPts([]); setOn(true); ui.set({ drawer: false }); toast('Tap points on the map — open this tab again to finish'); }}>📏 Start (tap points on the map)</button> : <>
        <p><b>{fmtKm(dist)}</b> · {pts.length} points</p>
        <label className="check"><input type="checkbox" checked={roads} onChange={(e) => setRoads(e.target.checked)} /><span>Follow roads (else straight lines)</span></label>
        <div className="btns sm">
          <button disabled={!pts.length} onClick={() => setPts(pts.slice(0, -1))}>Undo point</button>
          <button disabled={line.length < 2} onClick={() => act(null, async () => { const n = prompt('Track name', `Plan ${new Date().toLocaleDateString('en-IN')}`); if (!n) return; await saveLineAsTrack(line, n, engine.trip!.id, 'Planned'); toast('Saved in Tracks → Planned'); setOn(false); onSaved(); })}>Save as track</button>
          <button disabled={pts.length < 2} onClick={() => act(null, async () => { await engine.addMany(pts.map((p) => ({ p }))); setOn(false); toast('Added as stops of this ride'); })}>Use as ride stops</button>
          <button onClick={() => { setOn(false); setPts([]); }}>Close</button>
        </div>
      </>}
    </section>
  );
}
