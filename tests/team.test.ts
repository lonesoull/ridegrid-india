import { describe, it, expect } from 'vitest';
import { deriveTeam, isValidCode, newPairingCode, normalizeCode, open, pack, seal, unpack } from '../src/team/crypto';

describe('team encryption', () => {
  it('pairing codes are valid, normalised and unique', () => {
    const a = newPairingCode(), b = newPairingCode();
    expect(isValidCode(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(normalizeCode(a.toLowerCase().replace(/-/g, ' '))).toBe(a);
  });
  it('encrypts end-to-end; another team cannot read it; topic reveals nothing', async () => {
    const code = newPairingCode();
    const A = await deriveTeam(code), B = await deriveTeam(code), X = await deriveTeam(newPairingCode());
    expect(A.topicId).toBe(B.topicId);
    expect(A.topicId).not.toContain(code.slice(0, 5));
    const msg = { pos: [80.27, 13.0], name: 'Handlebar phone' };
    const box = await seal(A.key, msg);
    expect(new TextDecoder().decode(box)).not.toContain('Handlebar');
    expect(await open(B.key, box)).toEqual(msg);
    expect(await open(X.key, box)).toBeNull();
    box[20] ^= 1; // tampered
    expect(await open(B.key, box)).toBeNull();
  });
  it('packs big routes compactly and losslessly', async () => {
    const stops = Array.from({ length: 20000 }, (_, i) => [`id${i}`, 77 + i * 1e-4, 20 + i * 1e-4]);
    const s = await pack({ stops });
    expect(s.length).toBeLessThan(JSON.stringify(stops).length);
    expect((await unpack<{ stops: unknown[] }>(s)).stops).toEqual(stops);
  });
});
