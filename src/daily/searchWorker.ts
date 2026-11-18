/// <reference lib="webworker" />
import { PoiIndex } from './poiIndex';

/** Background thread holding the offline place index (hundreds of thousands of names per zone). */
let ix = new PoiIndex();
const zones = new Set<string>();
self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === 'add') { if (!zones.has(m.zone)) { ix.add(m.tsv); zones.add(m.zone); } (self as any).postMessage({ id: m.id, ok: true, size: ix.size }); }
    else if (m.type === 'reset') { ix = new PoiIndex(); zones.clear(); (self as any).postMessage({ id: m.id, ok: true }); }
    else if (m.type === 'search') (self as any).postMessage({ id: m.id, ok: true, result: ix.search(m.q, m.opts) });
    else if (m.type === 'nearby') (self as any).postMessage({ id: m.id, ok: true, result: ix.nearby(m.near) });
  } catch (e: any) { (self as any).postMessage({ id: m.id, ok: false, error: e?.message ?? String(e) }); }
};
