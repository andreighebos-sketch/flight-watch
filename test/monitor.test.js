import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db.js';
import { createMonitor } from '../src/monitor.js';
import { ErrorKind, ProviderError } from '../src/http.js';
import { finalizeOffer } from '../src/normalize.js';

const config = { refreshIntervalMinutes: 15, cacheTtlMinutes: 15, autoRefresh: false, manualRefreshCooldownSeconds: 10, dailyRequestLimit: 0, maxOffersPerDate: 10, concurrency: 3, minSpacingMs: 0 };
const noFx = { convertOffers: async (o) => o };
const quiet = { warn() {}, error() {} };

function offerFor(date, price, nowIso) {
  return finalizeOffer({
    id: `o_${date}`, source: 'fake', sourceLabel: 'Fake', dataMode: 'live', departureDate: date, totalPrice: price, currency: 'EUR', totalDurationMin: 1300, fetchedAt: nowIso,
    segments: [
      { origin: { iata: 'RMO' }, destination: { iata: 'IST' }, departureLocal: `${date}T06:00`, arrivalLocal: `${date}T07:30`, airline: { name: 'A', code: 'AA' }, flightNumber: 'AA1' },
      { origin: { iata: 'IST' }, destination: { iata: 'CXR' }, departureLocal: `${date}T10:00`, arrivalLocal: `${date}T23:00`, airline: { name: 'A', code: 'AA' }, flightNumber: 'AA2' },
    ],
    layovers: [{ durationMin: 150 }],
  });
}

function fakeProvider(priceFn, failFn = () => null, now = () => Date.now()) {
  const calls = [];
  return {
    calls,
    id: 'fake', label: 'Fake', dataMode: 'live', isConfigured: true, website: null, setupHelp: null,
    async searchDate(date) {
      calls.push(date);
      const err = failFn(date, calls.length);
      if (err) throw err;
      const fetchedAt = new Date(now()).toISOString();
      return { offers: [offerFor(date, priceFn(date), fetchedAt)], skipped: 0, fetchedAt, providerUpdatedAt: null };
    },
  };
}

describe('monitor', () => {
  it('searches all 27 dates, persists snapshots and reports price changes', async () => {
    const store = openDatabase(':memory:');
    let bump = 0;
    let t = Date.parse('2026-10-04T10:00:00Z');
    const provider = fakeProvider((d) => 1000 + Number(d.slice(-2)) - bump, () => null, () => t);
    const m = createMonitor({ config, provider, store, currency: noFx, clock: () => t, logger: quiet });
    await m.refresh({ trigger: 'manual' }).promise;
    expect(provider.calls).toHaveLength(27);
    expect(m.getStatus().lastRun).toMatchObject({ ok: 27, failed: 0, status: 'ok' });

    // within TTL: cache is used, provider not called again
    t += 5 * 60000;
    await m.refresh({ trigger: 'auto' }).promise;
    expect(provider.calls).toHaveLength(27);

    // after TTL: refetch; prices drop by 26
    bump = 26;
    t += 20 * 60000;
    await m.refresh({ trigger: 'auto' }).promise;
    expect(provider.calls).toHaveLength(54);
    const r = m.getResults();
    const day = r.dates.find((d) => d.date === '2026-10-28');
    expect(day.minPrice).toBe(1028 - 26);
    expect(day.change).toBe(-26);
    expect(day.lowestSeen).toBe(1002);
    expect(day.highestSeen).toBe(1028);
    const offer = r.offers.find((o) => o.departureDate === '2026-10-28');
    expect(offer.priceHistory.change).toBe(-26);
    expect(m.getDateHistory('2026-10-28').points).toHaveLength(2);
    expect(r.stats.cheapest.departureDate).toBe('2026-11-01'); // price = 1000 + day-of-month - 26
  });

  it('keeps partial results when single dates fail', async () => {
    const store = openDatabase(':memory:');
    const provider = fakeProvider(() => 900, (d) => (d === '2026-11-01' || d === '2026-11-02' ? new ProviderError('boom', { kind: ErrorKind.SERVER }) : null));
    const m = createMonitor({ config, provider, store, currency: noFx, logger: quiet });
    await m.refresh({ trigger: 'manual' }).promise;
    const st = m.getStatus();
    expect(st.lastRun).toMatchObject({ ok: 25, failed: 2, status: 'partial' });
    expect(m.getResults().dates.filter((d) => d.outcome === 'error')).toHaveLength(2);
  });

  it('stops the sweep on rate limit instead of hammering the provider', async () => {
    const store = openDatabase(':memory:');
    const provider = fakeProvider(() => 900, (d, n) => (n >= 3 ? new ProviderError('429', { kind: ErrorKind.RATE_LIMIT, status: 429 }) : null));
    const m = createMonitor({ config: { ...config, concurrency: 1 }, provider, store, currency: noFx, logger: quiet });
    await m.refresh({ trigger: 'manual' }).promise;
    expect(provider.calls).toHaveLength(3);
    const st = m.getStatus();
    expect(st.lastRun.status).toBe('aborted');
    expect(st.lastFatalError.kind).toBe('rate_limit');
    expect(st.lastRun.ok).toBe(2);
  });

  it('enforces the manual cooldown and the daily budget', async () => {
    const store = openDatabase(':memory:');
    const provider = fakeProvider(() => 900);
    const m = createMonitor({ config: { ...config, dailyRequestLimit: 5, concurrency: 1 }, provider, store, currency: noFx, logger: quiet });
    await m.refresh({ trigger: 'manual' }).promise;
    expect(provider.calls).toHaveLength(5);
    expect(m.getStatus().lastFatalError.kind).toBe('budget');
    expect(m.refresh({ trigger: 'manual' })).toMatchObject({ started: false, reason: 'cooldown' });
  });

  it('never runs without credentials', () => {
    const store = openDatabase(':memory:');
    const provider = { ...fakeProvider(() => 1), isConfigured: false, setupHelp: { envVar: 'X', steps: [] } };
    const m = createMonitor({ config, provider, store, currency: noFx, logger: quiet });
    expect(m.refresh({ trigger: 'manual' })).toEqual({ started: false, reason: 'missing_key' });
    expect(m.getStatus().provider.setup.envVar).toBe('X');
  });

  it('scopes history by data mode so demo never mixes with live', async () => {
    const store = openDatabase(':memory:');
    const live = fakeProvider(() => 900);
    await createMonitor({ config, provider: live, store, currency: noFx, logger: quiet }).refresh({}).promise;
    const demo = { ...fakeProvider(() => 1), dataMode: 'demo' };
    const m2 = createMonitor({ config, provider: demo, store, currency: noFx, logger: quiet });
    expect(m2.getResults().offers).toHaveLength(0);
  });
});
