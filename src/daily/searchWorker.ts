/// <reference lib="webworker" />
import { PoiIndex } from './poiIndex';

/** Background thread holding the offline place index (hundreds of thousands of names per zone). */
let ix = new PoiIndex();
const zones = new Set<string>();
self.onmessage = (ev: MessageEvent) => {
  const m = ev.data;
  try {
    if (m.type === 'addFile') {
      // read the zone's files straight from on-device storage here, so the screen never stalls on them
      void (async () => {
        try {
          const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('poi', { create: true });
          const read = async (n: string) => { try { return await (await (await d.getFileHandle(n)).getFile()).text(); } catch { return ''; } };
          if (!zones.has(m.zone)) { ix.add(await read(`${m.zone}.poi.tsv`)); zones.add(m.zone); }
          const rows = (await read(`${m.zone}.alerts.tsv`)).split('\n').filter(Boolean);
          const xy = new Float64Array(rows.length * 2); const kinds: string[] = [], speeds: string[] = [];
          rows.forEach((r, i) => { const [x, y, k, sp] = r.split('\t'); xy[2 * i] = +x; xy[2 * i + 1] = +y; kinds.push(k); speeds.push(sp ?? ''); });
          (self as any).postMessage({ id: m.id, ok: true, size: ix.size, xy, kinds, speeds }, [xy.buffer]);
        } catch (e: any) { (self as any).postMessage({ id: m.id, ok: false, error: e?.message ?? String(e) }); }
      })();
    }
    else if (m.type === 'add') { if (!zones.has(m.zone)) { ix.add(m.tsv); zones.add(m.zone); } (self as any).postMessage({ id: m.id, ok: true, size: ix.size }); }
    else if (m.type === 'reset') { ix = new PoiIndex(); zones.clear(); (self as any).postMessage({ id: m.id, ok: true }); }
    else if (m.type === 'search') (self as any).postMessage({ id: m.id, ok: true, result: ix.search(m.q, m.opts) });
    else if (m.type === 'nearby') (self as any).postMessage({ id: m.id, ok: true, result: ix.nearby(m.near) });
  } catch (e: any) { (self as any).postMessage({ id: m.id, ok: false, error: e?.message ?? String(e) }); }
};
