import type { LngLat } from '../core/geo';

/** OpenStreetMap contributions (OsmAnd "OSM editing"): map notes (no account needed) and the web editor. */
export async function createOsmNote(p: LngLat, text: string) {
  const u = `https://api.openstreetmap.org/api/0.6/notes.json?lat=${p[1].toFixed(6)}&lon=${p[0].toFixed(6)}&text=${encodeURIComponent(text + '\n\n#RideGrid')}`;
  const r = await fetch(u, { method: 'POST' });
  if (!r.ok) throw new Error(`OpenStreetMap refused the note (${r.status})`);
  const j = await r.json();
  return j?.properties?.id as number | undefined;
}
export async function osmNotesNear(p: LngLat, km = 2) {
  const d = km / 111;
  const u = `https://api.openstreetmap.org/api/0.6/notes.json?bbox=${(p[0] - d).toFixed(4)},${(p[1] - d).toFixed(4)},${(p[0] + d).toFixed(4)},${(p[1] + d).toFixed(4)}&limit=30&closed=0`;
  const j = await fetch(u).then((r) => r.json()).catch(() => null);
  return (j?.features ?? []).map((f: any) => ({ id: f.properties.id, p: f.geometry.coordinates as LngLat, text: f.properties.comments?.[0]?.text ?? '', url: `https://www.openstreetmap.org/note/${f.properties.id}` }));
}
export const osmEditUrl = (p: LngLat, z = 18) => `https://www.openstreetmap.org/edit#map=${z}/${p[1].toFixed(5)}/${p[0].toFixed(5)}`;
