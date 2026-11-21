/**
 * Stops / waypoints as Google's own map pins (Advanced Markers): numbered, always on top of the map,
 * tap to open, press-and-hold to drag (Google's native drag). Thousands of Expedition waypoints are
 * grouped into count bubbles when zoomed out, and only pins inside the screen are created.
 */
import Supercluster from 'supercluster';
import { engine } from '../core/engine';
import { ui, act } from '../ui/state';

declare const google: any;
const MAX_PINS = 300;

export class GoogleStops {
  private pins = new Map<string, { m: any; el: HTMLElement; sig: string }>();
  private index: Supercluster | null = null;
  private indexV = -1;
  private offs: (() => void)[] = [];
  private raf = 0;
  private dead = false;
  private Marker: any = null;
  constructor(private gmap: any) {
    void google.maps.importLibrary('marker').then((lib: any) => {
      if (this.dead) return;
      this.Marker = lib.AdvancedMarkerElement;
      this.schedule();
    }).catch(() => {});
    const l = gmap.addListener('idle', () => this.schedule());
    const off1 = engine.subscribe(() => this.schedule());
    const off2 = ui.subscribe(() => { if (ui.get().selectedId !== this.sel) this.schedule(); });
    this.offs.push(() => l.remove(), off1 as any, off2);
  }
  private sel: string | null = null;
  private schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.update(); }); }

  private pinEl(label: string, cls: string): HTMLElement {
    const el = document.createElement('div');
    el.className = `gpin ${cls}`;
    el.textContent = label;
    return el;
  }

  private update() {
    if (!this.Marker || this.dead) return;
    const b = this.gmap.getBounds?.();
    if (!b) return;
    const S = engine.stops, n = S.length;
    const zoom = this.gmap.getZoom() ?? 5;
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const padX = (ne.lng() - sw.lng()) * 0.15, padY = (ne.lat() - sw.lat()) * 0.15;
    const box: [number, number, number, number] = [sw.lng() - padX, sw.lat() - padY, ne.lng() + padX, ne.lat() + padY];
    this.sel = ui.get().selectedId;
    const want = new Map<string, { p: [number, number]; label: string; cls: string; stop?: number; cluster?: { id: number; count: number } }>();

    const visible: number[] = [];
    for (let i = 0; i < n; i++) { const s = S[i]; if (s.lng >= box[0] && s.lng <= box[2] && s.lat >= box[1] && s.lat <= box[3]) visible.push(i); }
    const role = (i: number) => (i === 0 ? 'start' : i === n - 1 ? 'end' : 'mid');
    if (visible.length <= MAX_PINS || zoom >= 15) {
      for (const i of visible.slice(0, MAX_PINS * 2)) {
        const s = S[i];
        want.set(s.id, { p: [s.lng, s.lat], label: String(i + 1), cls: `${role(i)}${s.id === this.sel ? ' sel' : ''}`, stop: i });
      }
    } else {
      // many waypoints on screen: count bubbles, like Google's grouped pins
      if (this.indexV !== engine.version || !this.index) {
        this.index = new Supercluster({ radius: 70, maxZoom: 16 });
        this.index.load(S.map((s, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [s.lng, s.lat] } })) as any);
        this.indexV = engine.version;
      }
      for (const f of this.index.getClusters(box, Math.floor(zoom)) as any[]) {
        const [x, y] = f.geometry.coordinates;
        if (f.properties.cluster) want.set(`c${f.properties.cluster_id}@${Math.floor(zoom)}`, { p: [x, y], label: f.properties.point_count.toLocaleString('en-IN'), cls: 'cluster', cluster: { id: f.properties.cluster_id, count: f.properties.point_count } });
        else { const i = f.properties.i, s = S[i]; want.set(s.id, { p: [s.lng, s.lat], label: String(i + 1), cls: `${role(i)}${s.id === this.sel ? ' sel' : ''}`, stop: i }); }
      }
    }
    // remove pins no longer wanted
    for (const [k, v] of this.pins) if (!want.has(k)) { v.m.map = null; this.pins.delete(k); }
    // add / update
    for (const [k, w] of want) {
      const sig = `${w.p[0]},${w.p[1]}|${w.label}|${w.cls}`;
      const have = this.pins.get(k);
      if (have) {
        if (have.sig === sig) continue;
        have.m.position = { lat: w.p[1], lng: w.p[0] };
        have.el.textContent = w.label; have.el.className = `gpin ${w.cls}`; have.sig = sig;
        continue;
      }
      const el = this.pinEl(w.label, w.cls);
      const m = new this.Marker({ map: this.gmap, position: { lat: w.p[1], lng: w.p[0] }, content: el, gmpDraggable: w.stop !== undefined && !engine.trip?.sequenceLock, zIndex: w.cluster ? 1 : 10 + (w.stop ?? 0) });
      m.addListener('click', () => {
        if (w.cluster) {
          const z = Math.min(this.index!.getClusterExpansionZoom(w.cluster.id), 18);
          this.gmap.moveCamera({ center: { lat: w.p[1], lng: w.p[0] }, zoom: z + 0.5 });
        } else if (w.stop !== undefined) ui.set({ selectedId: k });
      });
      if (w.stop !== undefined) m.addListener('dragend', () => {
        const pos = m.position; const lat = typeof pos.lat === 'function' ? pos.lat() : pos.lat, lng = typeof pos.lng === 'function' ? pos.lng() : pos.lng;
        void act(null, () => engine.moveStop(k, [lng, lat]));
      });
      this.pins.set(k, { m, el, sig });
    }
  }
  destroy() {
    this.dead = true; cancelAnimationFrame(this.raf);
    this.offs.forEach((f) => f());
    for (const v of this.pins.values()) v.m.map = null;
    this.pins.clear();
  }
}
