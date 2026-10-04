import { describe, expect, it, vi } from 'vitest';
import { buildSerpApiParams, createSerpApiProvider, parseSerpApiResponse } from '../src/providers/serpapi.js';
import { buildDuffelBody, createDuffelProvider, duffelModeFromToken, parseDuffelResponse } from '../src/providers/duffel.js';
import { buildDemoOffers } from '../src/providers/demo.js';

// Shapes follow https://serpapi.com/google-flights-api (response example).
const serpFixture = {
  search_metadata: { status: 'Success', processed_at: '2026-10-04 10:00:05 UTC', google_flights_url: 'https://www.google.com/travel/flights?hl=en&gl=md&curr=EUR&tfs=abc' },
  search_parameters: { engine: 'google_flights', currency: 'EUR', adults: 2, type: '2' },
  best_flights: [{
    flights: [
      { departure_airport: { name: 'Chișinău International Airport', id: 'RMO', time: '2026-10-28 06:15' }, arrival_airport: { name: 'Istanbul Airport', id: 'IST', time: '2026-10-28 07:50' }, duration: 95, airplane: 'Airbus A321', airline: 'Turkish Airlines', airline_logo: 'https://www.gstatic.com/flights/airline_logos/70px/TK.png', travel_class: 'Economy', flight_number: 'TK 270', extensions: ['Average legroom (31 in)'] },
      { departure_airport: { name: 'Istanbul Airport', id: 'IST', time: '2026-10-28 11:10' }, arrival_airport: { name: 'Tan Son Nhat International Airport', id: 'SGN', time: '2026-10-29 01:55' }, duration: 645, airline: 'Turkish Airlines', flight_number: 'TK 162' },
      { departure_airport: { name: 'Tan Son Nhat International Airport', id: 'SGN', time: '2026-10-29 06:00' }, arrival_airport: { name: 'Cam Ranh International Airport', id: 'CXR', time: '2026-10-29 07:05' }, duration: 65, airline: 'Vietjet', flight_number: 'VJ 600' },
    ],
    layovers: [{ duration: 200, name: 'Istanbul Airport', id: 'IST' }, { duration: 245, name: 'Tan Son Nhat International Airport', id: 'SGN', overnight: true }],
    total_duration: 1250,
    price: 1284,
    type: 'One way',
    extensions: ['Checked baggage for a fee', 'Self transfer'],
  }],
  other_flights: [
    { flights: [{ departure_airport: { id: 'RMO', time: '2026-10-28 09:00' }, arrival_airport: { id: 'CXR', time: '2026-10-29 09:00' }, duration: 1260, airline: 'X' }], total_duration: 1260 }, // no price → skipped
  ],
  airports: [{ departure: [{ airport: { id: 'RMO', name: 'Chișinău' }, city: 'Chișinău' }], arrival: [{ airport: { id: 'CXR', name: 'Cam Ranh' }, city: 'Nha Trang' }] }],
};

describe('SerpApi Google Flights adapter', () => {
  it('requests one-way RMO→CXR for 2 adults in EUR with no stop restriction', () => {
    const p = buildSerpApiParams('2026-10-28', { gl: 'md', hl: 'en', deepSearch: false });
    expect(Object.fromEntries(p)).toMatchObject({ engine: 'google_flights', type: '2', departure_id: 'RMO', arrival_id: 'CXR', outbound_date: '2026-10-28', adults: '2', currency: 'EUR' });
    expect(p.has('stops')).toBe(false);
    expect(p.has('api_key')).toBe(false);
  });
  it('normalizes a response into FlightOffers with total-for-2 semantics', () => {
    const { offers, skipped } = parseSerpApiResponse(serpFixture, { date: '2026-10-28', fetchedAt: '2026-10-04T10:00:06.000Z' });
    expect(skipped).toBe(1);
    expect(offers).toHaveLength(1);
    const o = offers[0];
    expect(o.totalPrice).toBe(1284);
    expect(o.pricePerPerson).toBe(642);
    expect(o.currency).toBe('EUR');
    expect(o.stops).toBe(2);
    expect(o.totalDurationMin).toBe(1250);
    expect(o.segments.map((s) => s.flightNumber)).toEqual(['TK270', 'TK162', 'VJ600']);
    expect(o.segments[0].departureLocal).toBe('2026-10-28T06:15');
    expect(o.layovers.map((l) => l.durationMin)).toEqual([200, 245]);
    expect(o.layovers[1].overnight).toBe(true);
    expect(o.baggage).toEqual(['Checked baggage for a fee']);
    expect(o.selfTransfer).toBe(true);
    expect(o.bookingUrl).toMatch(/^https:\/\/www\.google\.com\/travel\/flights/);
    expect(o.destination.city).toBe('Cam Ranh / Nha Trang');
    expect(o.providerUpdatedAt).toBe('2026-10-04T10:00:05.000Z');
  });
  it('treats "no results" as an empty date, not an error', () => {
    const r = parseSerpApiResponse({ search_metadata: { status: 'Success' }, error: "Google Flights hasn't returned any results for this query." }, { date: '2026-10-28', fetchedAt: 'x' });
    expect(r.offers).toEqual([]);
  });
  it('classifies 401 as auth and 429 as rate-limit/quota without retrying', async () => {
    const mkFetch = (status, body) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
    const f401 = mkFetch(401, { error: 'Invalid API key.' });
    await expect(createSerpApiProvider({ apiKey: 'k', gl: 'md', hl: 'en' }, { fetchImpl: f401 }).searchDate('2026-10-28')).rejects.toMatchObject({ kind: 'auth' });
    const f429 = mkFetch(429, { error: 'Your account has run out of searches.' });
    await expect(createSerpApiProvider({ apiKey: 'k', gl: 'md', hl: 'en' }, { fetchImpl: f429 }).searchDate('2026-10-28')).rejects.toMatchObject({ kind: 'quota' });
    expect(f429).toHaveBeenCalledTimes(1);
  });
  it('sends the key only to serpapi.com and refuses to run without it', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(serpFixture), { status: 200 }));
    await createSerpApiProvider({ apiKey: 'secret-key', gl: 'md', hl: 'en' }, { fetchImpl: f }).searchDate('2026-10-28');
    const url = new URL(f.mock.calls[0][0]);
    expect(url.origin).toBe('https://serpapi.com');
    expect(url.searchParams.get('api_key')).toBe('secret-key');
    await expect(createSerpApiProvider({ apiKey: '', gl: 'md', hl: 'en' }).searchDate('2026-10-28')).rejects.toMatchObject({ kind: 'config' });
  });
});

// Shapes follow https://duffel.com/docs/api/v2/offers
const duffelFixture = {
  data: {
    id: 'orq_1', live_mode: false, created_at: '2026-10-04T10:00:00Z',
    passengers: [{ type: 'adult', id: 'pas_1' }, { type: 'adult', id: 'pas_2' }],
    offers: [{
      id: 'off_1', total_amount: '1530.40', total_currency: 'EUR', base_amount: '1200.00', base_currency: 'EUR', tax_amount: '330.40', tax_currency: 'EUR', expires_at: '2026-10-04T10:30:00Z',
      owner: { name: 'Duffel Airways', iata_code: 'ZZ' },
      slices: [{
        duration: 'PT21H50M',
        segments: [
          { origin: { iata_code: 'RMO', name: 'Chișinău International Airport', city_name: 'Chișinău', time_zone: 'Europe/Chisinau' }, destination: { iata_code: 'DOH', name: 'Hamad International Airport', city_name: 'Doha', time_zone: 'Asia/Qatar' }, departing_at: '2026-10-28T14:00:00', arriving_at: '2026-10-28T19:30:00', duration: 'PT4H30M', marketing_carrier: { name: 'Duffel Airways', iata_code: 'ZZ' }, operating_carrier: { name: 'Duffel Airways', iata_code: 'ZZ' }, marketing_carrier_flight_number: '0101', passengers: [{ baggages: [{ type: 'checked', quantity: 1 }, { type: 'carry_on', quantity: 1 }], cabin_class_marketing_name: 'Economy' }] },
          { origin: { iata_code: 'DOH', name: 'Hamad International Airport', time_zone: 'Asia/Qatar' }, destination: { iata_code: 'CXR', name: 'Cam Ranh International Airport', time_zone: 'Asia/Ho_Chi_Minh' }, departing_at: '2026-10-29T01:30:00', arriving_at: '2026-10-29T12:50:00', duration: 'PT7H20M', marketing_carrier: { name: 'Duffel Airways', iata_code: 'ZZ' }, marketing_carrier_flight_number: '202', passengers: [] },
        ],
      }],
    }],
  },
};

describe('Duffel adapter', () => {
  it('detects sandbox vs live from the token', () => {
    expect(duffelModeFromToken('duffel_test_abc')).toBe('sandbox');
    expect(duffelModeFromToken('duffel_live_abc')).toBe('live');
  });
  it('requests 2 adult passengers, one slice, widened connections', () => {
    const b = buildDuffelBody('2026-10-28', { maxConnections: 2 });
    expect(b.data.passengers).toEqual([{ type: 'adult' }, { type: 'adult' }]);
    expect(b.data.slices).toEqual([{ origin: 'RMO', destination: 'CXR', departure_date: '2026-10-28' }]);
    expect(b.data.max_connections).toBe(2);
  });
  it('normalizes offers using time-zone aware layovers and total_amount for all passengers', () => {
    const { offers, mode } = parseDuffelResponse(duffelFixture, { date: '2026-10-28', fetchedAt: 'now', expectedMode: 'sandbox' });
    expect(mode).toBe('sandbox');
    const o = offers[0];
    expect(o.totalPrice).toBe(1530.4);
    expect(o.pricePerPerson).toBe(765.2);
    expect(o.baseFare).toBe(1200);
    expect(o.taxes).toBe(330.4);
    expect(o.totalDurationMin).toBe(21 * 60 + 50);
    expect(o.layovers[0].durationMin).toBe(360); // 19:30 → 01:30 Doha local (UTC+3)
    expect(o.segments[0].departureUtc).toBe('2026-10-28T12:00:00.000Z'); // Chișinău is UTC+2 after 25 Oct
    expect(o.segments[0].arrivalUtc).toBe('2026-10-28T16:30:00.000Z');
    expect(o.segments[0].flightNumber).toBe('ZZ101');
    expect(o.baggage).toContain('RMO→DOH: 1 × checked bag per passenger');
    expect(o.bookingUrl).toBeNull();
    expect(o.dataMode).toBe('sandbox');
  });
  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    let n = 0;
    const f = vi.fn(async () => (++n === 1
      ? new Response(JSON.stringify({ errors: [{ message: 'Too many requests' }] }), { status: 429, headers: { 'retry-after': '0' } })
      : new Response(JSON.stringify(duffelFixture), { status: 201 })));
    const r = await createDuffelProvider({ accessToken: 'duffel_test_x', maxConnections: 2, supplierTimeoutMs: 20000 }, { fetchImpl: f }).searchDate('2026-10-28');
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.offers).toHaveLength(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toMatch(/^https:\/\/api\.duffel\.com\/air\/offer_requests\?return_offers=true/);
    expect(init.headers['Duffel-Version']).toBe('v2');
  });
});

describe('demo provider', () => {
  it('is always tagged as demo data and never has booking links', () => {
    const offers = buildDemoOffers('2026-10-28', { now: new Date('2026-10-04T10:00:00Z') });
    expect(offers.length).toBeGreaterThan(0);
    for (const o of offers) {
      expect(o.dataMode).toBe('demo');
      expect(o.bookingUrl).toBeNull();
      expect(o.airlines.every((a) => a.startsWith('DEMO'))).toBe(true);
    }
  });
});
