/**
 * End-to-end encryption for the team link. Everything sent through the relay is AES-256-GCM
 * encrypted with a key derived from the team's pairing code; the relay only sees random bytes.
 */
const B32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1 (easy to type)

/** New pairing code: 25 random characters (~124 bits), grouped for reading. */
export function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(25));
  const s = Array.from(bytes, (b) => B32[b % B32.length]).join('');
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}-${s.slice(20, 25)}`;
}
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(.{5})(?=.)/g, '$1-');
export const isValidCode = (c: string) => normalizeCode(c).replace(/-/g, '').length === 25;

async function sha256(s: string) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Topic id (public) and AES key (secret) are derived separately so the topic reveals nothing. */
export async function deriveTeam(code: string) {
  const c = normalizeCode(code);
  const topicId = hex(await sha256(`ridegrid-topic:${c}`)).slice(0, 24);
  const raw = await sha256(`ridegrid-key:${c}`);
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { topicId, key };
}

export async function seal(key: CryptoKey, obj: unknown): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return out;
}

export async function open<T = any>(key: CryptoKey, buf: Uint8Array): Promise<T | null> {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch { return null; } // wrong team / tampered → ignored
}

/** gzip + base64 for big payloads (route push). */
export async function pack(obj: unknown): Promise<string> {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}
export async function unpack<T = any>(b64: string): Promise<T> {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as T;
}
