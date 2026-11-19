import { useEffect, useState } from 'react';
import { dailyMap, type DailyMapSettings } from './mapLayers';
import { offlineMaps, STYLE_LABEL, type DailyStyle, type MapZone } from './offlineMap';
import { ZONES } from '../route/device';
import { applyBase } from '../map/googleBase';
import { mapCtl } from '../ui/App';
import { act, toast } from '../ui/state';
import { google } from '../core/google';
import { sunTimes } from './sun';
import { offlineSearch, type PoiZone } from './offlineSearch';
import { canNativeFetch } from './nativeFetch';
import { weatherAt, weatherText, type Weather } from './weather';

const mb = (b?: number) => (b ? `${Math.round(b / 1048576).toLocaleString('en-IN')} MB` : '—');

/** Where region map files are downloaded from (GitHub Pages by default; a bigger free host can be set). */
export const mapServer = () => (localStorage.getItem('ridegrid.mapServer') || `${import.meta.env.BASE_URL}tiles`).replace(/\/$/, '');

/** Daily ride "Configure map" (OsmAnd-style): base style, overlays, offline maps, sun times. */
export function DailyMapTab() {
  const [, tick] = useState(0);
  const s = dailyMap.settings;
  useEffect(() => {
    const f = () => tick((x) => x + 1);
    dailyMap.listeners.add(f); offlineMaps.listeners.add(f);
    return () => { dailyMap.listeners.delete(f); offlineMaps.listeners.delete(f); };
  }, []);
  const set = (p: Partial<DailyMapSettings>) => act(null, async () => { await dailyMap.save(p); if (mapCtl) await applyBase(mapCtl, true); });
  const styles: (DailyStyle | 'google')[] = ['day', 'touring', 'topo', 'offroad', 'desert', 'bright', 'light', 'night', 'fiord', 'google'];
  const c = mapCtl?.map.getCenter();
  const sun = c ? sunTimes(new Date(), c.lat, c.lng) : null;
  return (
    <div className="stack">
      <section>
        <h3>Map style</h3>
        <div className="stylegrid">
          {styles.map((k) => (
            <button key={k} className={s.style === k ? 'on' : ''} disabled={k === 'google' && !google.settings.key}
              onClick={() => set({ style: k })}>{k === 'google' ? 'Google (live traffic)' : STYLE_LABEL[k]}</button>
          ))}
        </div>
        <label className="check"><input type="checkbox" checked={s.autoNight} onChange={(e) => set({ autoNight: e.target.checked })} /><span>Switch to the night map with the app's night mode</span></label>
      </section>

      <section>
        <h3>Layers</h3>
        <Toggle on={s.hillshade} label="Hillshade (hills & valleys)" onChange={(v) => set({ hillshade: v })} />
        <Toggle on={s.contours} label="Contour lines (height every 10–100 m)" onChange={(v) => set({ contours: v })} />
        <Toggle on={s.terrain3d} label="3D terrain (tilt the map to see it)" onChange={(v) => set({ terrain3d: v })} />
        <Toggle on={s.satellite} label="Satellite imagery" onChange={(v) => set({ satellite: v })} />
        <Toggle on={s.rain} label="Live rain radar (updates every 10 min)" onChange={(v) => set({ rain: v })} />
        <Toggle on={s.wiki} label="Wikipedia places (tap for the article)" onChange={(v) => set({ wiki: v })} />
        <Toggle on={s.photos} label="Street-level photos (Panoramax coverage)" onChange={(v) => set({ photos: v })} />
        <p className="muted">Terrain, satellite, radar, Wikipedia and photos need internet the first time; what you've viewed stays in the browser cache.</p>
      </section>

      <WeatherCard />

      {sun && <section>
        <h3>Sun</h3>
        <p>🌅 Sunrise <b>{sun.rise}</b> · 🌇 Sunset <b>{sun.set}</b> · daylight {sun.day}</p>
      </section>}

      <OfflineMapDownloads />
    </div>
  );
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <label className="check"><input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} /><span>{label}</span></label>;
}

function OfflineMapDownloads() {
  const [inst, setInst] = useState<MapZone[]>([]);
  const [meta, setMeta] = useState<Record<string, { bytes: number; generated?: string } | null>>({});
  const [prog, setProg] = useState<Record<string, string>>({});
  const [server, setServer] = useState(mapServer());
  const [poi, setPoi] = useState<PoiZone[]>([]);
  const [poiMeta, setPoiMeta] = useState<Record<string, { poi: number; alerts: number; generated: string } | null>>({});
  const reload = () => { void offlineSearch.installed().then(setPoi); return offlineMaps.installed().then(setInst); };
  const getSearch = (zone: string) => {
    setProg((x) => ({ ...x, ['s:' + zone]: 'downloading…' }));
    void offlineSearch.download(zone).then(() => toast('Offline search & road alerts ready for this region')).catch((e) => toast(e.message, 'error'))
      .finally(() => { setProg((x) => { const y = { ...x }; delete y['s:' + zone]; return y; }); void reload(); });
  };
  useEffect(() => {
    void reload();
    for (const z of ZONES) void fetch(`${import.meta.env.BASE_URL}poi/${z.zone}.poi.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((j) => setPoiMeta((m) => ({ ...m, [z.zone]: j })));
    for (const z of ZONES) void offlineMaps.meta(z.zone, server).then((j) => setMeta((m) => ({ ...m, [z.zone]: j })));
  }, [server]);
  const dl = (zone: string) => {
    setProg((x) => ({ ...x, [zone]: 'starting…' }));
    void offlineMaps.download(zone, server, (d, t) => setProg((x) => ({ ...x, [zone]: t ? `${Math.round((d / t) * 100)}% (${mb(d)} of ${mb(t)})` : mb(d) })))
      .then(() => { toast('Offline map ready'); if (mapCtl) void applyBase(mapCtl, true); if (!poi.some((x) => x.zone === zone) && poiMeta[zone]) getSearch(zone); })
      .catch((e) => toast(e.message, 'error'))
      .finally(() => { setProg((x) => { const y = { ...x }; delete y[zone]; return y; }); void reload(); });
  };
  return (
    <section>
      <h3>Offline maps</h3>
      <p className="muted">Download a region's full map (roads, places, buildings, water, parks) for use with no internet. Where nothing is downloaded the map loads online. Use Wi-Fi — regions are 120–630 MB; an interrupted download resumes.</p>
      {!canNativeFetch() && <p className="warn">Offline map downloads work in the RideGrid Android app (and the laptop app). In a browser tab the map loads online.</p>}
      {ZONES.map((z) => {
        const have = inst.find((i) => i.zone === z.zone), m = meta[z.zone], p = prog[z.zone];
        const sHave = poi.find((i) => i.zone === z.zone), sm = poiMeta[z.zone], sp = prog['s:' + z.zone];
        return (
          <div className="item" key={z.zone}>
            <div><b>{z.label}</b> {have && <span className="pill">{offlineMaps.zones.includes(z.zone) ? 'ready' : 'stored'}</span>}
              <div className="muted">{z.states}</div>
              <div className="muted">Map: {m ? `${mb(m.bytes)}` : m === null ? 'not available on this server yet' : '…'}{have?.generated ? ` · map data ${new Date(have.generated).toLocaleDateString('en-IN')}` : ''}</div>
              <div className="muted">Search & road alerts: {sHave ? `✓ ${sHave.poi.toLocaleString('en-IN')} places` : sm ? `${sm.poi.toLocaleString('en-IN')} places, ${sm.alerts.toLocaleString('en-IN')} alerts` : sm === null ? 'not available yet' : '…'}
                {sp ? ` · ${sp}` : sHave ? <> · <button className="link" onClick={() => act(null, () => offlineSearch.remove(z.zone)).then(reload)}>remove</button>{sm && sHave.generated !== sm.generated && <> · <button className="link" onClick={() => getSearch(z.zone)}>update</button></>}</> : sm ? <> · <button className="link" onClick={() => getSearch(z.zone)}>download</button></> : null}</div></div>
            <div className="btns sm">
              {p ? <span className="muted">{p}</span> : have
                ? <><button onClick={() => act(null, () => offlineMaps.remove(z.zone)).then(reload)}>Remove</button>
                    {m?.generated && have.generated !== m.generated && <button className="primary" onClick={() => dl(z.zone)}>Update</button>}</>
                : <button className="primary" disabled={!m || Object.keys(prog).length > 0} onClick={() => dl(z.zone)}>Download</button>}
            </div>
          </div>
        );
      })}
      <details>
        <summary className="muted">Map download server</summary>
        <input value={server} onChange={(e) => setServer(e.target.value)} onBlur={() => { try { localStorage.setItem('ridegrid.mapServer', server); } catch { /* ignore */ } }} />
      </details>
      <p className="muted small-note">Map data © OpenStreetMap contributors (ODbL), © OpenMapTiles. Online map: OpenFreeMap.</p>
    </section>
  );
}

function WeatherCard() {
  const [w, setW] = useState<Weather | null | undefined>(undefined);
  useEffect(() => { const c = mapCtl?.map.getCenter(); if (c) void weatherAt([c.lng, c.lat]).then(setW); }, []);
  if (w === undefined) return <section><h3>Weather</h3><p className="muted">Loading…</p></section>;
  if (!w) return <section><h3>Weather</h3><p className="muted">Needs internet.</p></section>;
  const rainSoon = w.hours.find((h) => h.rainPct >= 50);
  return (
    <section>
      <h3>Weather (map centre)</h3>
      <p><b>{weatherText(w.now.code)}</b> · {Math.round(w.now.temp)}°C · wind {Math.round(w.now.windKmh)} km/h · rain {w.now.rainPct}%</p>
      {rainSoon && <p className="warn">🌧 Rain likely from {new Date(rainSoon.t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} ({rainSoon.rainPct}%)</p>}
      <div className="wxrow">{w.hours.slice(0, 12).map((h) => (
        <div key={h.t}><span className="muted">{new Date(h.t).toLocaleTimeString('en-IN', { hour: 'numeric' })}</span><span>{weatherText(h.code).split(' ')[0]}</span><b>{Math.round(h.temp)}°</b><span className="muted">{h.rainPct}%</span></div>
      ))}</div>
      <p className="muted small-note">Forecast: Open-Meteo</p>
    </section>
  );
}
