import { describe, expect, it } from 'vitest';
import { dedupeCheapest, finalizeOffer, normalizeFlightNumber, parseMoney, pricePerPassenger, routeFingerprint } from '../src/normalize.js';
import { applyFilters, cheapestByDate, computeStats, sortOffers } from '../src/shared/offer-logic.js';

function seg(o, d, dep, arr, code, num, extra = {}) {
  return { origin: { iata: o }, destination: { iata: d }, departureLocal: dep, arrivalLocal: arr, durationMin: 120, airline: { name: `Air ${code}`, code }, flightNumber: `${code}${num}`, ...extra };
}
function draft(over = {}) {
  return {
    id: 'x1', source: 'test', sourceLabel: 'Test', dataMode: 'live', departureDate: '2026-10-28',
    totalPrice: '876.40', currency: 'EUR', totalDurationMin: 1500, fetchedAt: '2026-10-04T10:00:00.000Z',
    segments: [seg('RMO', 'IST', '2026-10-28T06:00', '2026-10-28T07:30', 'TK', 270), seg('IST', 'CXR', '2026-10-28T11:00', '2026-10-29T04:30', 'TK', 162)],
    layovers: [{ durationMin: 210 }],
    ...over,
  };
}

describe('price normalization', () => {
  it('parses provider amounts defensively', () => {
    expect(parseMoney('438.10')).toBe(438.1);
    expect(parseMoney(438)).toBe(438);
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney(-5)).toBeNull();
    expect(parseMoney(null)).toBeNull();
  });
  it('derives per-person from the two-adult TOTAL, never the reverse', () => {
    expect(pricePerPassenger(438, 2)).toBe(219);
    expect(pricePerPassenger(877.01, 2)).toBe(438.51);
    const o = finalizeOffer(draft());
    expect(o.totalPrice).toBe(876.4);
    expect(o.pricePerPerson).toBe(438.2);
    expect(o.passengers).toBe(2);
  });
});

describe('itinerary normalization', () => {
  it('computes stops, airlines, layovers and endpoints', () => {
    const o = finalizeOffer(draft());
    expect(o.stops).toBe(1);
    expect(o.origin.iata).toBe('RMO');
    expect(o.destination.iata).toBe('CXR');
    expect(o.airlines).toEqual(['Air TK']);
    expect(o.layovers[0]).toMatchObject({ airport: { iata: 'IST' }, durationMin: 210, changeOfAirport: null });
  });
  it('detects a change of airport during a layover', () => {
    const o = finalizeOffer(draft({ segments: [seg('RMO', 'IST', '2026-10-28T06:00', '2026-10-28T07:30', 'TK', 1), seg('SAW', 'CXR', '2026-10-28T13:00', '2026-10-29T04:30', 'VJ', 2)] }));
    expect(o.layovers[0].changeOfAirport.iata).toBe('SAW');
  });
  it('rejects offers that cannot be shown truthfully', () => {
    expect(() => finalizeOffer(draft({ totalPrice: null }))).toThrow();
    expect(() => finalizeOffer(draft({ currency: 'euro' }))).toThrow();
    expect(() => finalizeOffer(draft({ segments: [] }))).toThrow();
    expect(() => finalizeOffer(draft({ segments: [seg('RMO', 'NHA', '2026-10-28T06:00', '2026-10-28T20:00', 'XX', 1)] }))).toThrow(/does not match/);
  });
  it('keeps unlimited stop counts (no artificial cap)', () => {
    const hubs = ['RMO', 'OTP', 'IST', 'DXB', 'KUL', 'SGN', 'CXR'];
    const segments = hubs.slice(0, -1).map((h, i) => seg(h, hubs[i + 1], `2026-10-28T0${i}:00`, `2026-10-28T0${i}:50`, 'ZZ', i + 1));
    const o = finalizeOffer(draft({ segments, layovers: [] }));
    expect(o.stops).toBe(5);
    expect(applyFilters([o], {}).length).toBe(1);
    expect(applyFilters([o], { stops: '4plus' }).length).toBe(1);
    expect(applyFilters([o], { stops: '3' }).length).toBe(0);
  });
});

describe('route fingerprinting', () => {
  it('is stable across provider offer IDs and prices', () => {
    const a = finalizeOffer(draft({ id: 'off_1', totalPrice: 900 }));
    const b = finalizeOffer(draft({ id: 'off_2', totalPrice: 850 }));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[a-f0-9]{40}$/);
  });
  it('changes when flight number, time or date changes', () => {
    const base = finalizeOffer(draft());
    const otherFlight = finalizeOffer(draft({ segments: [seg('RMO', 'IST', '2026-10-28T06:00', '2026-10-28T07:30', 'TK', 268), draft().segments[1]] }));
    const otherTime = finalizeOffer(draft({ segments: [seg('RMO', 'IST', '2026-10-28T09:00', '2026-10-28T10:30', 'TK', 270), draft().segments[1]] }));
    expect(new Set([base.fingerprint, otherFlight.fingerprint, otherTime.fingerprint]).size).toBe(3);
    expect(routeFingerprint({ ...base, departureDate: '2026-10-29' })).not.toBe(base.fingerprint);
  });
  it('normalizes flight numbers', () => {
    expect(normalizeFlightNumber(null, 'TK 0269')).toBe('TK269');
    expect(normalizeFlightNumber('VN', '5')).toBe('VN5');
  });
  it('dedupes identical itineraries keeping the cheapest', () => {
    const a = finalizeOffer(draft({ totalPrice: 900 }));
    const b = finalizeOffer(draft({ totalPrice: 850 }));
    expect(dedupeCheapest([a, b]).map((o) => o.totalPrice)).toEqual([850]);
  });
});

describe('sorting and stats', () => {
  const mk = (price, dur, stops, dep, date = '2026-10-28') => ({ totalPrice: price, currency: 'EUR', totalDurationMin: dur, stops, departureLocal: dep, departureDate: date, airlines: ['A'] });
  const offers = [mk(900, 1500, 1, '2026-10-28T10:00'), mk(700, 3000, 3, '2026-10-28T06:00'), mk(800, 1200, 2, '2026-10-28T08:00', '2026-10-29'), { ...mk(100, 900, 0, '2026-10-28T01:00'), currency: 'USD' }];
  it('sorts by cheapest total for 2 adults by default, unconverted currencies last', () => {
    expect(sortOffers(offers).map((o) => o.totalPrice)).toEqual([700, 800, 900, 100]);
  });
  it('supports fastest, fewest stops and earliest departure', () => {
    expect(sortOffers(offers, 'fastest')[0].totalDurationMin).toBe(900);
    expect(sortOffers(offers, 'fewest_stops')[0].stops).toBe(0);
    expect(sortOffers(offers, 'earliest')[0].departureLocal).toBe('2026-10-28T01:00');
  });
  it('computes cheapest per date and summary stats', () => {
    const byDate = cheapestByDate(offers, ['2026-10-28', '2026-10-29', '2026-10-30']);
    expect(byDate.map((d) => d.minPrice)).toEqual([700, 800, null]);
    const s = computeStats(offers);
    expect(s.cheapest.totalPrice).toBe(700);
    expect(s.fastest.totalPrice).toBe(800);
    expect(s.medianPrice).toBe(800);
  });
  it('filters by duration and price with "any" defaults', () => {
    expect(applyFilters(offers, { maxDurationH: '24' }).map((o) => o.totalPrice)).toEqual([800, 100]);
    expect(applyFilters(offers, { maxPrice: '850' }).map((o) => o.totalPrice)).toEqual([700, 800]);
    expect(applyFilters(offers, { stops: 'any', maxDurationH: 'any' })).toHaveLength(4);
  });
});
