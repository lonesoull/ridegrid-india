import { Capacitor } from '@capacitor/core';
import { makeBundle, applyBundle } from './syncBackup';

/** Google Drive backup of Daily places & settings (OsmAnd Cloud equivalent), in Drive's hidden app folder.
 *  Needs the rider's own Google OAuth Client ID (Web application). Google does not allow its login inside
 *  app WebViews, so in the Android app this works when RideGrid is opened in Chrome / installed from Chrome. */
const K = { client: 'ridegrid.drive.client', last: 'ridegrid.drive.last', auto: 'ridegrid.drive.auto' };
const ls = { get: (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };
const NAME = 'ridegrid-daily-backup.json';
let token: { v: string; exp: number } | null = null;

function gis(): Promise<any> {
  const w = window as any;
  if (w.google?.accounts?.oauth2) return Promise.resolve(w.google.accounts.oauth2);
  return new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => ok(w.google.accounts.oauth2); s.onerror = () => bad(new Error('Could not load Google sign-in'));
    document.head.appendChild(s);
  });
}

export const drive = {
  get clientId() { return ls.get(K.client); }, set clientId(v: string) { ls.set(K.client, v.trim()); },
  get auto() { return ls.get(K.auto) === '1'; }, set auto(v: boolean) { ls.set(K.auto, v ? '1' : '0'); },
  get last() { return +ls.get(K.last) || 0; },
  get blockedHere() { return Capacitor.isNativePlatform(); },
  get signedIn() { return !!token && token.exp > Date.now(); },
  async signIn(): Promise<string> {
    if (this.signedIn) return token!.v;
    if (!this.clientId) throw new Error('Add your Google OAuth Client ID first');
    if (this.blockedHere) throw new Error('Google does not allow its sign-in inside apps. Open RideGrid in Chrome for Drive backup, or use Export.');
    const o = await gis();
    return new Promise((ok, bad) => {
      const c = o.initTokenClient({ client_id: this.clientId, scope: 'https://www.googleapis.com/auth/drive.appdata',
        callback: (r: any) => { if (r.error || !r.access_token) bad(new Error(r.error_description || r.error || 'Google sign-in failed')); else { token = { v: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000 }; ok(r.access_token); } },
        error_callback: (e: any) => bad(new Error(e?.message ?? 'Google sign-in was closed')) });
      c.requestAccessToken({ prompt: '' });
    });
  },
  async fileId(t: string): Promise<string | null> {
    const j = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(`name='${NAME}'`)}&fields=files(id,modifiedTime)`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    return j.files?.[0]?.id ?? null;
  },
  async backup() {
    const t = await this.signIn();
    const id = await this.fileId(t);
    const meta = id ? {} : { name: NAME, parents: ['appDataFolder'] };
    const body = new FormData();
    body.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    body.append('file', new Blob([JSON.stringify(await makeBundle())], { type: 'application/json' }));
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files${id ? '/' + id : ''}?uploadType=multipart`, { method: id ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${t}` }, body });
    if (!r.ok) throw new Error(`Drive backup failed (${r.status})`);
    ls.set(K.last, String(Date.now()));
  },
  async restore() {
    const t = await this.signIn();
    const id = await this.fileId(t);
    if (!id) throw new Error('No RideGrid backup in this Google Drive yet');
    const b = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json());
    await applyBundle(b);
  },
  /** Automatic: back up once a day while signed in (Google keeps the sign-in about an hour per session). */
  startAuto(onNeedSignIn: () => void) {
    const tick = () => {
      if (!this.auto || !navigator.onLine || Date.now() - this.last < 24 * 3600e3) return;
      if (this.signedIn) void this.backup().catch(() => {});
      else if (!this.blockedHere && this.clientId) onNeedSignIn();
    };
    setTimeout(tick, 30000); setInterval(tick, 3600e3);
  },
};
