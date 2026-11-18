import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { fromRows, parseCoordinateText, fromGeoJSON } from '../src/io/importers';
import { RideDB, useDB } from '../src/core/db';
import { engine } from '../src/core/engine';
import { createTrip } from '../src/core/trips';
import { toCSV, toGPX, toKML } from '../src/io/exporters';

describe('importers', () => {
  it('parses pasted lat,lng lists with names', () => {
    const r = parseCoordinateText('28.613939, 77.209023, India Gate\n27.175015 78.042155 Taj\nbad line');
    expect(r).toEqual([{ p: [77.209023, 28.613939], name: 'India Gate' }, { p: [78.042155, 27.175015], name: 'Taj' }]);
  });
  it('detects CSV columns by header and headerless lng,lat', () => {
    expect(fromRows([['Name', 'Longitude', 'Latitude'], ['A', 77.2, 28.6]])).toEqual([{ p: [77.2, 28.6], name: 'A' }]);
    expect(fromRows([[77.2, 28.6], [78, 27]])[0].p).toEqual([77.2, 28.6]);
  });
  it('samples tracks when there are no waypoints', () => {
    const line = Array.from({ length: 101 }, (_, i) => [77 + i * 0.001, 28]);
    const r = fromGeoJSON({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } }, { trackSampleM: 1000, prefer: 'auto' });
    expect(r.stops.length).toBeGreaterThan(8);
    expect(r.stops.length).toBeLessThan(13);
  });
});

describe('exporters', () => {
  it('writes GPX 1.1 / KML / CSV for the active route', async () => {
    useDB(new RideDB('io'));
    const t = await createTrip('Test <Trip>');
    await engine.loadTrip(t.id);
    await engine.addMany([{ p: [77, 28], name: 'A&B' }, { p: [77.1, 28.1] }, { p: [77.2, 28] }]);
    const gpx = toGPX('Test <Trip>');
    expect(gpx).toContain('version="1.1"');
    expect(gpx).toContain('Test &lt;Trip&gt;');
    expect((gpx.match(/<wpt /g) || []).length).toBe(3);
    expect(toKML('x')).toContain('<Folder><name>Unrouted legs</name>');
    const csv = toCSV().split('\n');
    expect(csv.length).toBe(4);
    expect(csv[1]).toContain('"A&B"');
  });
});
