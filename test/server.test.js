import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bootstrap, offersToCsv } from '../src/server.js';

let ctx;
let base;
let server;
beforeAll(async () => {
  ctx = bootstrap({ FLIGHT_PROVIDER: 'serpapi', SERPAPI_API_KEY: '', DB_PATH: ':memory:', AUTO_REFRESH: 'false' });
  server = ctx.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

describe('HTTP API', () => {
  it('reports the missing API key with setup instructions and no secrets', async () => {
    const st = await (await fetch(`${base}/api/status`)).json();
    expect(st.provider.configured).toBe(false);
    expect(st.provider.setup.envVar).toBe('SERPAPI_API_KEY');
    const res = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(409);
  });
  it('validates input and exposes no proxy endpoints', async () => {
    expect((await fetch(`${base}/api/history/date/2027-01-01`)).status).toBe(400);
    expect((await fetch(`${base}/api/history/offer/not-a-hash`)).status).toBe(400);
    expect((await fetch(`${base}/api/proxy?url=https://example.com`)).status).toBe(404);
    const bad = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"force":"yes"}' });
    expect(bad.status).toBe(400);
  });
  it('serves results for the whole 27-day range', async () => {
    const r = await (await fetch(`${base}/api/results`)).json();
    expect(r.search).toMatchObject({ origin: 'RMO', destination: 'CXR', adults: 2, tripType: 'one_way' });
    expect(r.dates).toHaveLength(27);
  });
  it('does not ship secrets or provider endpoints in the frontend bundle', () => {
    const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    expect(js).not.toMatch(/api_key|serpapi\.com\/search|api\.duffel\.com|SERPAPI_API_KEY|DUFFEL_ACCESS_TOKEN/);
  });
  it('escapes CSV cells against formula injection', () => {
    const csv = offersToCsv([{ departureDate: '2026-10-28', departureLocal: 'x', arrivalLocal: 'y', totalDurationMin: 60, stops: 0, segments: [{ origin: { iata: 'RMO' }, destination: { iata: 'CXR' }, flightNumber: 'A1' }], airlines: ['=HYPERLINK("x")'], totalPrice: 1, pricePerPerson: 0.5, currency: 'EUR', selfTransfer: false, sourceLabel: 's', dataMode: 'live', fetchedAt: 't', bookingUrl: null }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
