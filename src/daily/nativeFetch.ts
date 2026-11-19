import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Downloads that a web page can't make (GitHub release files send no CORS headers): inside the
 * Android app (and the laptop app) they go through the app's native HTTP, in ranged chunks so a
 * 600 MB map never sits in memory and an interrupted download can resume.
 */
export const RELEASES = 'https://github.com/lonesoull/ridegrid-india/releases/download';
export const canNativeFetch = () => Capacitor.isNativePlatform();

const b64 = (s: string) => { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

async function nativeGet(url: string, headers: Record<string, string> = {}, responseType: 'arraybuffer' | 'json' = 'arraybuffer') {
  const r = await CapacitorHttp.request({ url, method: 'GET', headers, responseType, connectTimeout: 30000, readTimeout: 120000 });
  if (r.status >= 400) throw new Error(`Download failed (${r.status})`);
  return r;
}

export async function nativeJson<T = any>(url: string): Promise<T | null> {
  try {
    const r = await nativeGet(url, {}, 'json');
    return (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as T;
  } catch { return null; }
}

/** Stream a big file into a writable (OPFS) in 8 MB ranges; `from` resumes a partial download. */
export async function nativeDownload(url: string, total: number, write: (chunk: Uint8Array) => Promise<void>, from = 0, onProgress?: (done: number, total: number) => void) {
  const CH = 8 * 1048576;
  let done = from;
  while (done < total) {
    const end = Math.min(total, done + CH) - 1;
    let tries = 0;
    for (;;) {
      try {
        const r = await nativeGet(url, { Range: `bytes=${done}-${end}` });
        const bytes = typeof r.data === 'string' ? b64(r.data) : new Uint8Array(r.data as ArrayBuffer);
        if (!bytes.length) throw new Error('empty chunk');
        await write(bytes);
        done += bytes.length;
        break;
      } catch (e) {
        if (++tries >= 5) throw e;
        await new Promise((res) => setTimeout(res, 3000 * tries));
      }
    }
    onProgress?.(done, total);
  }
  return done;
}
