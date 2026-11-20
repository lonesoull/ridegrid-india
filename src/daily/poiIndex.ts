/**
 * Offline place search (OsmAnd-style): names, categories, streets, towns from the per-zone files
 * built by tools/build-poi.mjs. Pure TypeScript (runs in a worker and in tests).
 */
export type LngLat = [number, number];
const RAD = Math.PI / 180;

export const CAT_LABEL: Record<string, string> = {
  fuel: 'Fuel station', ev: 'EV charging', atm: 'ATM', bank: 'Bank', hospital: 'Hospital', clinic: 'Clinic', pharmacy: 'Pharmacy', police: 'Police',
  restaurant: 'Restaurant', fast_food: 'Fast food', cafe: 'Café', toilets: 'Toilets', parking: 'Parking', bus: 'Bus station', worship: 'Place of worship',
  water: 'Drinking water', fire: 'Fire station', post: 'Post office', market: 'Market', wash: 'Bike/car wash', school: 'School / college',
  moto_shop: 'Motorcycle shop', mechanic: 'Mechanic', tyres: 'Tyres / puncture', supermarket: 'Supermarket', shop: 'Shop', food_shop: 'Bakery / food shop', mall: 'Mall',
  hotel: 'Hotel', guest_house: 'Guest house', hostel: 'Hostel', camp: 'Camp site', attraction: 'Attraction', viewpoint: 'Viewpoint', museum: 'Museum',
  picnic: 'Picnic spot', info: 'Tourist info', historic: 'Historic site', park: 'Park', rail: 'Railway station', airport: 'Airport',
  address: 'Address', city: 'City', town: 'Town', village: 'Village', hamlet: 'Hamlet', suburb: 'Suburb', locality: 'Area', peak: 'Peak', waterfall: 'Waterfall', beach: 'Beach', street: 'Street', postcode: 'PIN code',
};
/** Rider filters stored with each place (from OpenStreetMap tags). */
export const FLAG_LABEL: Record<string, string> = { veg: '🥗 Veg', pureveg: '🟢 Pure veg', cng: 'CNG', lpg: 'LPG', diesel: 'Diesel', e20: 'E20', ev_type2: 'EV Type 2', ev_ccs: 'EV CCS', ev_chademo: 'EV CHAdeMO', '24h': '24 hours', toilets: 'Toilets', air: 'Tyre air' };
export const hitFlags = (h: { info: string }) => (h.info.split('|')[4] ?? '').split(',').filter(Boolean);
/** Words people type for a category (English + common Indian usage). */
const SYN: Record<string, string[]> = {
  fuel: ['fuel', 'petrol', 'diesel', 'pump', 'bunk', 'gas station', 'filling'], ev: ['ev', 'charging', 'charger'], atm: ['atm', 'cash'], bank: ['bank'],
  hospital: ['hospital', 'emergency', 'casualty'], clinic: ['clinic', 'doctor'], pharmacy: ['pharmacy', 'medical', 'chemist', 'medicine'], police: ['police', 'thana', 'police station'],
  restaurant: ['restaurant', 'food', 'dhaba', 'hotel food', 'meals', 'eat'], fast_food: ['fast food', 'snacks'], cafe: ['cafe', 'coffee', 'tea', 'chai'],
  toilets: ['toilet', 'restroom', 'washroom'], parking: ['parking'], bus: ['bus stand', 'bus station'], water: ['water'], mechanic: ['mechanic', 'repair', 'service', 'garage', 'workshop'],
  tyres: ['tyre', 'tire', 'puncture'], moto_shop: ['bike shop', 'motorcycle', 'spare'], hotel: ['hotel', 'lodge', 'stay', 'room'], guest_house: ['guest house', 'homestay'],
  hostel: ['hostel'], camp: ['camp', 'camping'], viewpoint: ['viewpoint', 'view point'], attraction: ['attraction', 'tourist'], rail: ['railway', 'train station'],
  worship: ['temple', 'mosque', 'church', 'gurudwara'], supermarket: ['supermarket', 'grocery'], waterfall: ['waterfall', 'falls'], beach: ['beach'], peak: ['peak', 'hill top'], postcode: ['pin', 'pincode', 'pin code', 'postcode', 'postal code', 'zip'],
};
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ऀ-෿]+/g, ' ').trim();

export interface Hit { name: string; cat: string; label: string; p: LngLat; info: string; distM?: number; alongM?: number; offM?: number; score: number }
export interface SearchOpts { near?: LngLat | null; cat?: string; limit?: number; along?: { pts: LngLat[]; maxM: number; fromS?: number } }

export class PoiIndex {
  private x: number[] = []; private y: number[] = []; private c: string[] = []; private n: string[] = []; private nn: string[] = []; private inf: string[] = [];
  get size() { return this.x.length; }

  add(tsv: string) {
    for (const line of tsv.split('\n')) {
      if (!line) continue;
      const [lon, lat, cat, name = '', info = ''] = line.split('\t');
      this.x.push(+lon); this.y.push(+lat); this.c.push(cat); this.n.push(name); this.nn.push(' ' + norm(name)); this.inf.push(info);
    }
  }

  /** Which category a query names ("petrol pump" → fuel), if any. */
  static categoryFor(q: string): string | null {
    const s = norm(q).replace(/\b(near ?me|nearby|near|the|a|station|shop|centre|center|stand|s)\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    for (const [cat, l] of Object.entries(CAT_LABEL)) if (norm(l) === s) return cat;
    // only when every word of the query is a category word ("petrol pump", "mechanic") — "Beach Road" stays a name search
    const words = s.split(' ');
    for (const [cat, syn] of Object.entries(SYN)) {
      const vocab = new Set(syn.flatMap((w) => w.split(' ')));
      if (words.every((w) => vocab.has(w) || vocab.has(w.replace(/s$/, '')) || (w.length >= 4 && [...vocab].some((v) => v.startsWith(w))))) return cat;
    }
    return null;
  }

  search(q: string, o: SearchOpts = {}): Hit[] {
    const limit = o.limit ?? 30;
    const cat = o.cat ?? (q ? PoiIndex.categoryFor(q) : null);
    const toks = cat && !o.cat ? [] : norm(q).split(' ').filter(Boolean);
    const near = o.near ?? null;
    const kx = near ? Math.cos(near[1] * RAD) * 111320 : 111320;
    const along = o.along ? routeGrid(o.along.pts) : null;
    const out: Hit[] = [];
    for (let i = 0; i < this.x.length; i++) {
      if (cat && this.c[i] !== cat) continue;
      if (!cat && !toks.length) continue;
      let score = 0;
      if (toks.length) {
        const nm = this.nn[i];
        let ok = true, exact = 0;
        for (const t of toks) {
          const at = nm.indexOf(' ' + t);
          if (at < 0) { if (t.length >= 4 && nm.includes(t)) continue; ok = false; break; }
          if (nm.startsWith(' ' + t + ' ', at) || nm.length === at + t.length + 1) exact++;
        }
        if (!ok) continue;
        score = 1 + exact + (this.nn[i].trim() === toks.join(' ') ? 3 : 0) + (/^(city|town)$/.test(this.c[i]) ? 2 : /^(village|suburb)$/.test(this.c[i]) ? 1 : 0);
      }
      const p: LngLat = [this.x[i], this.y[i]];
      let alongM: number | undefined, offM: number | undefined;
      if (along) {
        const a = along.nearest(p);
        if (!a || a.d > o.along!.maxM || (o.along!.fromS !== undefined && a.s < o.along!.fromS)) continue;
        alongM = a.s; offM = a.d;
      }
      const distM = near ? Math.hypot((p[0] - near[0]) * kx, (p[1] - near[1]) * 110540) : undefined;
      out.push({ name: this.n[i] || CAT_LABEL[this.c[i]] || this.c[i], cat: this.c[i], label: CAT_LABEL[this.c[i]] ?? this.c[i], p, info: this.inf[i], distM, alongM, offM, score });
      if (out.length > 20000) break;
    }
    // along the route: in order ahead; otherwise best match, then nearest
    out.sort(along ? (a, b) => a.alongM! - b.alongM! : (a, b) => b.score - a.score || (a.distM ?? 0) - (b.distM ?? 0));
    return out.slice(0, limit);
  }

  /** Nearest places of the popular categories (the "Nearby" card). */
  nearby(near: LngLat, cats = ['fuel', 'restaurant', 'mechanic', 'atm', 'hospital', 'hotel', 'police', 'toilets'], perCat = 3) {
    return cats.map((c) => ({ cat: c, label: CAT_LABEL[c], hits: this.search('', { near, cat: c, limit: perCat }) })).filter((g) => g.hits.length);
  }
}

/** Points sampled along a route, bucketed in ~2 km cells, for "along the route" search. */
function routeGrid(pts: LngLat[]) {
  const C = 0.02, cells = new Map<number, number[]>(), cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot((pts[i][0] - pts[i - 1][0]) * Math.cos(pts[i][1] * RAD) * 111320, (pts[i][1] - pts[i - 1][1]) * 110540));
  pts.forEach((p, i) => { const k = Math.floor(p[0] / C) * 100000 + Math.floor(p[1] / C); const a = cells.get(k); if (a) a.push(i); else cells.set(k, [i]); });
  return {
    nearest(p: LngLat) {
      const cx = Math.floor(p[0] / C), cy = Math.floor(p[1] / C);
      let best: { d: number; s: number } | null = null;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const i of cells.get((cx + dx) * 100000 + cy + dy) ?? []) {
          const d = Math.hypot((pts[i][0] - p[0]) * Math.cos(p[1] * RAD) * 111320, (pts[i][1] - p[1]) * 110540);
          if (!best || d < best.d) best = { d, s: cum[i] };
        }
      }
      return best;
    },
  };
}
