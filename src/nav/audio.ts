/** Loud, simple tones that cut through helmet speakers, plus optional voice. */
let ctx: AudioContext | null = null;

/** Must be called from a user tap once (browsers block audio until then). */
export function unlockAudio() {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch { /* no audio */ }
}

function tone(freq: number, startS: number, durS: number, type: OscillatorType = 'square', vol = 0.35) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, ctx.currentTime + startS);
  g.gain.linearRampToValueAtTime(vol, ctx.currentTime + startS + 0.01);
  g.gain.setValueAtTime(vol, ctx.currentTime + startS + durS - 0.03);
  g.gain.linearRampToValueAtTime(0, ctx.currentTime + startS + durS);
  o.connect(g).connect(ctx.destination);
  o.start(ctx.currentTime + startS); o.stop(ctx.currentTime + startS + durS + 0.02);
}

export const sounds = {
  /** urgent two-tone alarm */
  offRoute() { unlockAudio(); tone(880, 0, 0.18); tone(587, 0.2, 0.18); tone(880, 0.4, 0.18); tone(587, 0.6, 0.25); },
  /** pleasant rising chime */
  arrival() { unlockAudio(); tone(660, 0, 0.12, 'sine', 0.4); tone(990, 0.13, 0.22, 'sine', 0.4); },
  backOnRoute() { unlockAudio(); tone(523, 0, 0.1, 'sine', 0.3); tone(784, 0.11, 0.15, 'sine', 0.3); },
  test() { unlockAudio(); tone(660, 0, 0.15, 'sine', 0.4); },
};

export function say(text: string) {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-IN'; u.rate = 1.05; u.volume = 1;
    speechSynthesis.speak(u);
  } catch { /* ignore */ }
}

/** Keep the screen on while navigating; re-acquired automatically when the app comes back. */
export class WakeLock {
  private lock: any = null;
  private want = false;
  constructor() {
    document.addEventListener('visibilitychange', () => { if (this.want && document.visibilityState === 'visible') void this.acquire(); });
  }
  get supported() { return 'wakeLock' in navigator; }
  get active() { return !!this.lock && !this.lock.released; }
  async on() { this.want = true; await this.acquire(); }
  async off() { this.want = false; try { await this.lock?.release(); } catch { /* */ } this.lock = null; }
  private async acquire() {
    if (!this.supported || this.active) return;
    try { this.lock = await (navigator as any).wakeLock.request('screen'); } catch { /* denied (e.g. battery saver) */ }
  }
}
