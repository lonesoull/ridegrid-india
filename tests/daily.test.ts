import { describe, it, expect } from 'vitest';
import { PoiIndex } from '../src/daily/poiIndex';
import { parseCoords } from '../src/daily/coords';

const TSV = [
  '80\t13\tfuel\tIOCL Beach Road\t24/7||Indian Oil',
  '80.05\t13.05\ttown\tMahabalipuram\t',
  '80.003\t13.003\tmechanic\tRaju Bike Works\t',
  '80.041\t13.001\thotel\tSea View Hotel\t|+91 44 1234',
  '80.5\t13.5\tfuel\tHP Petrol Far Away\t',
  '80.02\t13\tstreet\tBeach Road\t',
].join('\n');

describe('offline search', () => {
  const ix = new PoiIndex(); ix.add(TSV);
  it('finds by name words (prefix) and ranks towns', () => {
    expect(ix.search('mahab')[0].name).toBe('Mahabalipuram');
    expect(ix.search('beach road').map((h) => h.name)).toContain('Beach Road');
    expect(ix.search('raju')[0].cat).toBe('mechanic');
  });
  it('understands category words like "petrol pump" and sorts by distance', () => {
    const r = ix.search('petrol pump', { near: [80.01, 13.01] });
    expect(r.map((h) => h.cat)).toEqual(['fuel', 'fuel']);
    expect(r[0].name).toBe('IOCL Beach Road');
    expect(r[0].distM!).toBeLessThan(2000);
  });
  it('searches along a route, in order ahead', () => {
    const route: [number, number][] = Array.from({ length: 50 }, (_, i) => [80 + i * 0.001, 13]);
    const r = ix.search('', { cat: 'fuel', along: { pts: route, maxM: 2000 } });
    expect(r.length).toBe(1); // the far one is not along the route
    expect(r[0].offM!).toBeLessThan(50);
  });
  it('nearby card groups categories', () => {
    const g = ix.nearby([80, 13]);
    expect(g.find((x) => x.cat === 'fuel')!.hits[0].name).toBe('IOCL Beach Road');
  });
});

describe('coordinate input', () => {
  const close = (a: number[] | null, b: number[], tol = 1e-3) => { expect(a).not.toBeNull(); expect(Math.abs(a![0] - b[0])).toBeLessThan(tol); expect(Math.abs(a![1] - b[1])).toBeLessThan(tol); };
  it('decimal and DMS', () => {
    close(parseCoords('12.9716, 77.5946'), [77.5946, 12.9716]);
    close(parseCoords(`12°58'17.8"N 77°35'40.6"E`), [77.5946, 12.9716]);
  });
  it('plus code', () => close(parseCoords('849VCWC8+R9'), [-122.0841, 37.4220], 2e-3));
  it('UTM', () => close(parseCoords('43P 781481 1435426'), [77.5946, 12.9716], 1e-4));
  it('rejects text', () => expect(parseCoords('Beach Road')).toBeNull());
});

import { translate } from '../src/daily/voice';
describe('Indian-language voice', () => {
  it('translates turn prompts and keeps road names', () => {
    expect(translate('In 300 metres, turn left onto MG Road', 'hi-IN')).toBe('300 मीटर बाद, MG Road पर बाएँ मुड़ें');
    expect(translate('At the roundabout, take the 2nd exit', 'ta-IN')).toBe('ரவுண்டானாவில் 2 வெளியேறலை எடுக்கவும்');
    expect(translate('Speed camera ahead', 'kn-IN')).toBe('ಮುಂದೆ ವೇಗ ಕ್ಯಾಮೆರಾ ಇದೆ');
    expect(translate('Some new sentence', 'hi-IN')).toBe('Some new sentence');
  });
});

import { analyse } from '../src/daily/trackTools';
describe('track analysis', () => {
  it('distance, moving time, splits and climb', () => {
    // 3 km east at 10 m/s, climbing 0 → 60 m
    const pts = Array.from({ length: 311 }, (_, i) => [i * 1000, 77 + i * (10 / 108400), 13, 5, 10, i * 0.2] as any);
    const s = analyse(pts);
    expect(s.distM).toBeGreaterThan(3000); expect(s.distM).toBeLessThan(3200);
    expect(Math.round(s.avgKmh)).toBe(36);
    expect(s.splits.length).toBe(3);
    expect(s.climbM).toBeGreaterThan(50);
  });
});

import { locationFromText } from '../src/daily/coords';
describe('shared locations', () => {
  it('reads geo:, Google Maps and WhatsApp links', () => {
    expect(locationFromText('geo:12.9716,77.5946?q=12.9716,77.5946')).toEqual([77.5946, 12.9716]);
    expect(locationFromText('https://www.google.com/maps/place/X/@13.0827,80.2707,15z')).toEqual([80.2707, 13.0827]);
    expect(locationFromText('https://maps.google.com/?q=28.6139,77.2090')).toEqual([77.209, 28.6139]);
    expect(locationFromText('hello')).toBeNull();
  });
});
