/// <reference lib="webworker" />
import { Graph, routeMulti, linkGraphs, unlinkGraph, type LngLat } from './graph';

/** Background thread: holds the downloaded road graphs and answers routing requests. */
const graphs = new Map<string, Graph>();


self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === 'load') {
      const t = performance.now();
      const g = new Graph(m.buf);
      const old = graphs.get(m.zone);
      if (old) { graphs.delete(m.zone); unlinkGraph(old, graphs.values()); }
      // join it to the regions already loaded at their shared border junctions
      const links: Record<string, number> = {};
      for (const [z, o] of graphs) links[z] = linkGraphs(g, o);
      graphs.set(m.zone, g);
      (self as any).postMessage({ id: m.id, ok: true, ms: performance.now() - t, bbox: g.bbox, V: g.V, U: g.U, links, zones: [...graphs.keys()] });
    } else if (m.type === 'unload') {
      const g = graphs.get(m.zone);
      graphs.delete(m.zone);
      if (g) unlinkGraph(g, graphs.values());
      (self as any).postMessage({ id: m.id, ok: true, zones: [...graphs.keys()] });
    } else if (m.type === 'covers') {
      (self as any).postMessage({ id: m.id, ok: true, result: (m.points as LngLat[]).map((p) => [...graphs.values()].some((g) => g.contains(p))) });
    } else if (m.type === 'route') {
      const pts = m.points as LngLat[];
      const legs = [];
      const t = performance.now();
      for (let i = 0; i < pts.length - 1; i++) {
        const r = routeMulti([...graphs.values()], pts[i], pts[i + 1]);
        legs.push(r ? { coords: r.coords, distM: r.distM, names: r.names, timeS: r.timeS } : null);
      }
      (self as any).postMessage({ id: m.id, ok: true, result: legs, ms: performance.now() - t });
    } else if (m.type === 'snap') {
      const g = [...graphs.values()].find((x) => x.contains(m.p));
      const s = g?.snap(m.p, 300);
      (self as any).postMessage({ id: m.id, ok: true, result: s ? s.p : null });
    }
  } catch (e: any) {
    (self as any).postMessage({ id: m.id, ok: false, error: e?.message ?? String(e) });
  }
};
