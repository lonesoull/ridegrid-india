/** Import favourites from OsmAnd (favourites.gpx), Google Takeout (Saved Places.json / saved list .csv), KML / GeoJSON. Pure: no DOM. */
export interface FavIn { name: string; p: [number, number]; group?: string; note?: string }

const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (xml: string, t: string) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${t}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${t}>`)); return m ? unxml(m[1]) : undefined; };
const ok = (lng: number, lat: number) => Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
/** Coordinates inside a Google Maps link: @lat,lng · ?q=lat,lng · !3dlat!4dlng */
export function coordsFromGoogleUrl(u: string): [number, number] | null {
  const m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ?? u.match(/[?&](?:q|query|ll|destination)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/) ?? u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  return m && ok(+m[2], +m[1]) ? [+m[2], +m[1]] : null;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export function parseFavourites(text: string, fileName = ''): { items: FavIn[]; skipped: number } {
  const items: FavIn[] = []; let skipped = 0;
  const t = text.trim();
  const base = fileName.replace(/\.[^.]+$/, '') || 'Imported';
  if (t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t);
    const feats: any[] = Array.isArray(j) ? j : j.features ?? [];
    for (const f of feats) {
      const pr = f.properties ?? {};
      const c = f.geometry?.coordinates;
      let p: [number, number] | null = Array.isArray(c) && ok(+c[0], +c[1]) ? [+c[0], +c[1]] : null;
      const loc = pr.location ?? {};
      if (!p && loc.latitude !== undefined) p = ok(+loc.longitude, +loc.latitude) ? [+loc.longitude, +loc.latitude] : null;
      if (!p && pr.google_maps_url) p = coordsFromGoogleUrl(pr.google_maps_url);
      const name = loc.name ?? pr.Title ?? pr.title ?? pr.name ?? loc.address ?? 'Saved place';
      if (p) items.push({ name: String(name), p, group: 'Google saved places', note: loc.address ?? pr.Comment ?? pr.description }); else skipped++;
    }
  } else if (/<gpx\b/i.test(t)) {
    for (const m of t.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/g)) {
      const lat = +(m[1].match(/lat="([^"]+)"/)?.[1] ?? NaN), lon = +(m[1].match(/lon="([^"]+)"/)?.[1] ?? NaN);
      if (!ok(lon, lat)) { skipped++; continue; }
      // OsmAnd keeps the favourite group in <type>
      items.push({ name: tag(m[2], 'name') ?? 'Favourite', p: [lon, lat], group: tag(m[2], 'type') || 'OsmAnd favourites', note: tag(m[2], 'desc') });
    }
  } else if (/<kml\b/i.test(t)) {
    for (const m of t.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g)) {
      const c = tag(m[1], 'coordinates')?.split(/[\s]+/)[0]?.split(',');
      if (!c || !ok(+c[0], +c[1]) || /<(LineString|Polygon)\b/.test(m[1])) { skipped++; continue; }
      items.push({ name: tag(m[1], 'name') ?? 'Place', p: [+c[0], +c[1]], group: base, note: tag(m[1], 'description') });
    }
  } else {
    // Google Takeout saved list: Title,Note,URL,…
    const rows = csvRows(t);
    const head = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
    const ti = head.indexOf('title'), ni = head.indexOf('note'), ui = head.indexOf('url');
    const lat = head.findIndex((h) => h === 'lat' || h === 'latitude'), lng = head.findIndex((h) => h === 'lng' || h === 'lon' || h === 'longitude');
    for (const r of rows.slice(1)) {
      const p = lat >= 0 && lng >= 0 && ok(+r[lng], +r[lat]) ? [+r[lng], +r[lat]] as [number, number] : ui >= 0 ? coordsFromGoogleUrl(r.slice(ui, ui + 1 + Math.max(0, r.length - head.length)).join(',')) : null;
      if (p) items.push({ name: r[ti >= 0 ? ti : 0] || 'Saved place', p, group: base, note: ni >= 0 ? r[ni] : undefined }); else skipped++;
    }
  }
  return { items, skipped };
}

/** Favourites as an OsmAnd-compatible GPX. */
export function favouritesGpx(list: { name: string; p: [number, number]; group?: string; note?: string }[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RideGrid" xmlns="http://www.topografix.com/GPX/1/1">\n${list.map((f) =>
    `  <wpt lat="${f.p[1]}" lon="${f.p[0]}"><name>${esc(f.name)}</name>${f.note ? `<desc>${esc(f.note)}</desc>` : ''}<type>${esc(f.group ?? 'Favourites')}</type></wpt>`).join('\n')}\n</gpx>\n`;
}
