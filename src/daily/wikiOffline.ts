/** Offline Wikipedia / Wikivoyage for chosen areas (OsmAnd's offline Wikipedia): titles, places and short
 *  summaries saved on the phone, so the map dots and their text work with no signal. */
export interface WikiItem { t: string; id: number; x: number; y: number; s: string; site: string }
export interface WikiArea { id: string; name: string; site: string; bbox: [number, number, number, number]; n: number; at: number }
const AK = 'ridegrid.wiki.areas', CACHE = 'rg-wiki-v1';
const url = (id: string) => `${location.origin}/__rg-wiki/${id}.json`;
let mem: WikiItem[] | null = null;

export const wikiOffline = {
  areas(): WikiArea[] { try { return JSON.parse(localStorage.getItem(AK) ?? '[]'); } catch { return []; } },
  setAreas(a: WikiArea[]) { try { localStorage.setItem(AK, JSON.stringify(a)); } catch { /* ignore */ } mem = null; },
  async items(): Promise<WikiItem[]> {
    if (mem) return mem;
    if (!('caches' in window)) return [];
    const c = await caches.open(CACHE);
    const all: WikiItem[] = [];
    for (const a of this.areas()) { const r = await c.match(url(a.id)); if (r) all.push(...(await r.json())); }
    return (mem = all);
  },
  async near(bbox: [number, number, number, number], site: string): Promise<WikiItem[]> {
    return (await this.items()).filter((i) => i.site === site && i.x >= bbox[0] && i.x <= bbox[2] && i.y >= bbox[1] && i.y <= bbox[3]).slice(0, 300);
  },
  async summary(title: string, site: string) { return (await this.items()).find((i) => i.t === title && i.site === site)?.s; },
  /** Download every article in the box (up to ~80 × 80 km per area). */
  async save(name: string, bbox: [number, number, number, number], site: string, onProgress?: (msg: string) => void): Promise<WikiArea> {
    const [w, s, e, n] = bbox;
    const stepY = 0.12, stepX = 0.12 / Math.cos((((s + n) / 2) * Math.PI) / 180);
    if ((e - w) / stepX * ((n - s) / stepY) > 60) throw new Error('Area too big — zoom in to about 80 km across');
    const found = new Map<number, { t: string; x: number; y: number }>();
    let k = 0;
    for (let y = s + stepY / 2; y < n + stepY / 2; y += stepY) for (let x = w + stepX / 2; x < e + stepX / 2; x += stepX) {
      onProgress?.(`Finding articles… ${++k}`);
      const j = await fetch(`https://${site}/w/api.php?action=query&list=geosearch&gscoord=${Math.min(y, n).toFixed(4)}|${Math.min(x, e).toFixed(4)}&gsradius=10000&gslimit=500&format=json&origin=*`).then((r) => r.json()).catch(() => null);
      for (const g of j?.query?.geosearch ?? []) if (g.lon >= w && g.lon <= e && g.lat >= s && g.lat <= n) found.set(g.pageid, { t: g.title, x: g.lon, y: g.lat });
    }
    const ids = [...found.keys()], items: WikiItem[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      onProgress?.(`Saving summaries… ${Math.min(i + 20, ids.length)} / ${ids.length}`);
      const part = ids.slice(i, i + 20);
      const j = await fetch(`https://${site}/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exsentences=4&exlimit=20&pageids=${part.join('|')}&format=json&origin=*`).then((r) => r.json()).catch(() => null);
      for (const id of part) { const f = found.get(id)!; items.push({ t: f.t, id, x: f.x, y: f.y, s: (j?.query?.pages?.[id]?.extract ?? '').slice(0, 700), site }); }
    }
    const area: WikiArea = { id: `${site.split('.')[1]}-${Date.now().toString(36)}`, name, site, bbox, n: items.length, at: Date.now() };
    const c = await caches.open(CACHE);
    await c.put(url(area.id), new Response(JSON.stringify(items), { headers: { 'Content-Type': 'application/json' } }));
    this.setAreas([...this.areas(), area]);
    return area;
  },
  async remove(id: string) { if ('caches' in window) await (await caches.open(CACHE)).delete(url(id)); this.setAreas(this.areas().filter((a) => a.id !== id)); },
};
