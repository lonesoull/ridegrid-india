import { useEffect, useState } from 'react';
import { markers, MARKER_COLORS } from './markers';
import type { MyPlace } from '../core/db';
import { nav } from '../nav/navigator';
import { myLocation } from '../nav/directions';
import { mapCtl } from '../ui/App';
import { act, toast, ui } from '../ui/state';
import { haversine, fmtKm, type LngLat } from '../core/geo';

/** Daily "My places" (OsmAnd favourites, markers, parking, notes). */
export function PlacesTab() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((x) => x + 1); markers.listeners.add(f); return () => { markers.listeners.delete(f); }; }, []);
  const me: LngLat | null = nav.pos ?? (mapCtl ? [mapCtl.map.getCenter().lng, mapCtl.map.getCenter().lat] : null);
  const here = async (): Promise<LngLat> => nav.pos ?? (await myLocation().catch(() => me!));
  const groups = markers.groups();
  const park = markers.parking();
  return (
    <div className="stack">
      <section>
        <h3>Favourites</h3>
        <div className="btns">
          <button className="primary" onClick={() => act(null, async () => { const n = prompt('Name (e.g. Home, Office, Mechanic)'); if (!n) return; const g = prompt('Group', groups[0] ?? 'Favourites') || 'Favourites'; await markers.put({ kind: 'fav', name: n, p: await here(), group: g }); toast('Saved'); })}>★ Save my location</button>
          <button onClick={() => act(null, async () => { const n = prompt('Name'); if (!n) return; const c = mapCtl!.map.getCenter(); await markers.put({ kind: 'fav', name: n, p: [c.lng, c.lat], group: groups[0] ?? 'Favourites' }); })}>★ Save map centre</button>
        </div>
        {!markers.favourites().length && <p className="muted">No favourites yet. Places you save show on the map with a star; tap one for directions.</p>}
        {groups.map((g) => (
          <details key={g} open>
            <summary><b>{g}</b> <span className="muted">({markers.favourites().filter((x) => (x.group || 'Favourites') === g).length})</span></summary>
            {markers.favourites().filter((x) => (x.group || 'Favourites') === g).map((x) => <Row key={x.id} x={x} me={me} />)}
          </details>
        ))}
      </section>

      <section>
        <h3>Map markers</h3>
        <p className="muted">Up to 3 active markers show at the top of the map with an arrow pointing at them and the distance.</p>
        <button onClick={() => act(null, async () => { const c = mapCtl!.map.getCenter(); await markers.put({ kind: 'marker', name: `Marker ${markers.active().length + 1}`, p: [c.lng, c.lat], active: true }); })}>⚑ Marker at map centre</button>
        {markers.all().filter((x) => x.kind === 'marker').map((x) => <Row key={x.id} x={x} me={me} />)}
      </section>

      <section>
        <h3>Parked bike</h3>
        {park ? <>
          <Row x={park} me={me} />
          <div className="btns">
            <button onClick={() => act(null, async () => { const m = prompt('Remind me in how many minutes?', '60'); if (m) await markers.update(park.id, { until: Date.now() + +m * 60000 }); })}>⏱ Set reminder</button>
            <button onClick={() => act(null, () => markers.remove(park.id))}>Picked up the bike</button>
          </div>
        </> : <button className="primary" onClick={() => act(null, async () => { await markers.put({ kind: 'parking', name: 'My bike', p: await here() }); toast('Parking spot saved'); })}>P Park here</button>}
      </section>

      <section>
        <h3>Notes on the map</h3>
        <p className="muted">Text, photo, video and voice notes pinned where you made them (use the quick buttons ✎ 📷 🎙 on the map).</p>
        {!markers.notes().length && <p className="muted">No notes yet.</p>}
        {markers.notes().map((x) => <Row key={x.id} x={x} me={me} />)}
      </section>
    </div>
  );
}

function Row({ x, me }: { x: MyPlace; me: LngLat | null }) {
  return (
    <div className="item">
      <div><b style={{ color: x.color }}>{x.kind === 'fav' ? '★' : x.kind === 'marker' ? '⚑' : x.kind === 'parking' ? 'P' : '✎'} {x.name}</b>
        <div className="muted">{me ? fmtKm(haversine(me, x.p)) : ''}{x.kind === 'marker' && x.active === false ? ' · done' : ''}{x.until ? ` · reminder ${new Date(x.until).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}{x.media?.length ? ` · ${x.media.length} media` : ''}</div></div>
      <div className="btns sm">
        <button onClick={() => { mapCtl?.map.flyTo({ center: x.p, zoom: 16 }); ui.set({ drawer: false }); }}>Show</button>
        <button onClick={() => { ui.set({ drawer: false, place: { id: `my:${x.id}`, name: x.name, address: x.group ?? '', p: x.p, provider: 'osm' } }); }}>Go</button>
        <button onClick={() => { const n = prompt('Name', x.name); if (n) void markers.update(x.id, { name: n }); }}>Rename</button>
        {x.kind === 'fav' && <button onClick={() => { const g = prompt('Move to group', x.group ?? 'Favourites'); if (g) void markers.update(x.id, { group: g }); }}>Group</button>}
        {x.kind !== 'note' && <button onClick={() => void markers.update(x.id, { color: MARKER_COLORS[(MARKER_COLORS.indexOf(x.color ?? '') + 1) % MARKER_COLORS.length] })}>Colour</button>}
        {x.kind === 'marker' && <button onClick={() => void markers.update(x.id, { active: x.active === false })}>{x.active === false ? 'Activate' : 'Done'}</button>}
        <button className="danger" onClick={() => confirm(`Delete “${x.name}”?`) && void markers.remove(x.id)}>✕</button>
      </div>
    </div>
  );
}
