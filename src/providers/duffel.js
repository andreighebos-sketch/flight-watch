import { SEARCH } from '../constants.js';
import { describeAirport } from '../airports.js';
import { localToUtcIso, normalizeLocalDateTime, parseIsoDurationToMinutes } from '../dates.js';
import { ErrorKind, ProviderError, fetchJson, parseRetryAfter, withRetry } from '../http.js';
import { finalizeOffer, normalizeFlightNumber } from '../normalize.js';

/**
 * Duffel Flights API v2 — POST https://api.duffel.com/air/offer_requests
 * Docs: https://duffel.com/docs/api/v2/offer-requests/create-offer-request
 * `total_amount` is the price of the offer for ALL passengers incl. taxes.
 * Test tokens (duffel_test_…) only return fictional "Duffel Airways" content → SANDBOX.
 */
export const DUFFEL_ENDPOINT = 'https://api.duffel.com/air/offer_requests';
const ID = 'duffel';

export function duffelModeFromToken(token) {
  if (token.startsWith('duffel_test_')) return 'sandbox';
  if (token.startsWith('duffel_live_')) return 'live';
  return 'unknown';
}

export function buildDuffelBody(date, cfg) {
  return {
    data: {
      slices: [{ origin: SEARCH.origin, destination: SEARCH.destination, departure_date: date }],
      passengers: Array.from({ length: SEARCH.adults }, () => ({ type: 'adult' })),
      cabin_class: 'economy',
      // Duffel's default is 1 connection; we send the widest value configured.
      max_connections: cfg.maxConnections,
    },
  };
}

function baggageSummary(segments) {
  const lines = new Set();
  for (const seg of segments) {
    for (const p of Array.isArray(seg.passengers) ? seg.passengers : []) {
      for (const b of Array.isArray(p.baggages) ? p.baggages : []) {
        if (!Number.isInteger(b?.quantity)) continue;
        const kind = b.type === 'checked' ? 'checked bag' : b.type === 'carry_on' ? 'carry-on bag' : `${b.type} bag`;
        lines.add(`${seg.origin?.iata_code}→${seg.destination?.iata_code}: ${b.quantity} × ${kind} per passenger`);
      }
    }
  }
  return [...lines];
}

export function duffelOfferToFlightOffer(o, ctx) {
  const slice = Array.isArray(o?.slices) ? o.slices[0] : null;
  const raw = Array.isArray(slice?.segments) ? slice.segments : [];
  if (!raw.length) throw new Error('offer without segments');
  const segments = raw.map((s) => {
    const depLocal = normalizeLocalDateTime(s.departing_at);
    const arrLocal = normalizeLocalDateTime(s.arriving_at);
    const depTz = s.origin?.time_zone || null;
    const arrTz = s.destination?.time_zone || null;
    const mk = s.marketing_carrier || {};
    const op = s.operating_carrier || {};
    return {
      origin: describeAirport(s.origin?.iata_code, s.origin?.name, s.origin?.city_name),
      destination: describeAirport(s.destination?.iata_code, s.destination?.name, s.destination?.city_name),
      departureLocal: depLocal,
      arrivalLocal: arrLocal,
      departureTz: depTz,
      arrivalTz: arrTz,
      departureUtc: localToUtcIso(depLocal, depTz),
      arrivalUtc: localToUtcIso(arrLocal, arrTz),
      durationMin: parseIsoDurationToMinutes(s.duration),
      airline: { name: mk.name || null, code: mk.iata_code || null, logo: mk.logo_symbol_url || null },
      operatingAirline: op.iata_code && op.iata_code !== mk.iata_code ? { name: op.name || null, code: op.iata_code } : null,
      flightNumber: s.marketing_carrier_flight_number ? normalizeFlightNumber(mk.iata_code, s.marketing_carrier_flight_number) : null,
      aircraft: s.aircraft?.name || null,
      cabin: s.passengers?.[0]?.cabin_class_marketing_name || null,
      overnight: false,
      notes: [],
    };
  });
  const notes = [];
  if (o.owner?.name) notes.push(`Ticketing airline: ${o.owner.name}`);
  if (o.expires_at) notes.push(`Offer valid until ${o.expires_at}`);
  return finalizeOffer({
    id: o.id,
    source: ID,
    sourceLabel: ctx.mode === 'sandbox' ? 'Duffel (test mode)' : 'Duffel',
    dataMode: ctx.mode,
    departureDate: ctx.date,
    totalPrice: o.total_amount,
    currency: String(o.total_currency || '').toUpperCase(),
    baseFare: o.base_currency === o.total_currency ? o.base_amount : null,
    taxes: o.tax_currency === o.total_currency ? o.tax_amount : null,
    priceNote: 'Duffel total_amount for all passengers incl. taxes; payment fees and optional services not included.',
    totalDurationMin: parseIsoDurationToMinutes(slice.duration),
    segments,
    layovers: [],
    bookingUrl: null, // Duffel is a booking API — it has no consumer booking page per offer
    baggage: baggageSummary(raw),
    selfTransfer: o.type === 'split_ticket',
    notes,
    expiresAt: o.expires_at || null,
    fetchedAt: ctx.fetchedAt,
    providerUpdatedAt: o.created_at || ctx.fetchedAt,
  });
}

export function parseDuffelResponse(json, { date, fetchedAt, expectedMode }) {
  const data = json?.data;
  if (!data || !Array.isArray(data.offers)) {
    throw new ProviderError('Duffel returned an unexpected response shape', { kind: ErrorKind.INVALID_RESPONSE, provider: ID });
  }
  const mode = data.live_mode === true ? 'live' : data.live_mode === false ? 'sandbox' : expectedMode;
  if (Array.isArray(data.passengers) && data.passengers.length !== SEARCH.adults) {
    throw new ProviderError(`Duffel priced ${data.passengers.length} passenger(s) instead of ${SEARCH.adults}`, { kind: ErrorKind.INVALID_RESPONSE, provider: ID });
  }
  const offers = [];
  let skipped = 0;
  for (const o of data.offers) {
    try {
      offers.push(duffelOfferToFlightOffer(o, { date, fetchedAt, mode }));
    } catch {
      skipped += 1;
    }
  }
  return { offers, skipped, mode, providerUpdatedAt: data.created_at || fetchedAt };
}

function classify(status, json, headers) {
  const e = Array.isArray(json?.errors) ? json.errors[0] : null;
  const msg = e?.message || e?.title || `HTTP ${status}`;
  if (status === 401 || status === 403) return new ProviderError(`Duffel rejected the access token: ${msg}`, { kind: ErrorKind.AUTH, status, provider: ID });
  if (status === 429) {
    const wait = parseRetryAfter(headers.get('retry-after')) ?? parseRetryAfter(headers.get('ratelimit-reset'));
    return new ProviderError(`Duffel rate limit reached: ${msg}`, { kind: ErrorKind.RATE_LIMIT, status, retryable: wait !== null && wait <= 65000, retryAfterMs: wait, provider: ID });
  }
  if (status >= 500) return new ProviderError(`Duffel server error: ${msg}`, { kind: ErrorKind.SERVER, status, retryable: true, provider: ID });
  return new ProviderError(`Duffel request rejected: ${msg}`, { kind: ErrorKind.BAD_REQUEST, status, provider: ID });
}

export function createDuffelProvider(cfg, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const mode = duffelModeFromToken(cfg.accessToken);
  return {
    id: ID,
    label: mode === 'sandbox' ? 'Duffel (test mode)' : 'Duffel',
    dataMode: mode === 'unknown' ? 'live' : mode,
    website: 'https://duffel.com/docs/api/v2/offer-requests',
    isConfigured: Boolean(cfg.accessToken),
    setupHelp: {
      envVar: 'DUFFEL_ACCESS_TOKEN',
      steps: [
        'Sign up at https://app.duffel.com/join',
        'Developers → Access tokens: create a token (duffel_test_… = sandbox, duffel_live_… after live activation)',
        'Put DUFFEL_ACCESS_TOKEN=<token> into .env (FLIGHT_PROVIDER=duffel) and restart the server.',
      ],
    },
    async searchDate(date, { signal } = {}) {
      if (!cfg.accessToken) throw new ProviderError('DUFFEL_ACCESS_TOKEN is not set', { kind: ErrorKind.CONFIG, provider: ID });
      const url = `${DUFFEL_ENDPOINT}?return_offers=true&supplier_timeout=${cfg.supplierTimeoutMs}`;
      return withRetry(async () => {
        const fetchedAt = new Date().toISOString();
        const { status, json, headers } = await fetchJson(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.accessToken}`,
            'Duffel-Version': 'v2',
            Accept: 'application/json',
            'Accept-Encoding': 'gzip',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(buildDuffelBody(date, cfg)),
          timeoutMs: Math.max(timeoutMs, cfg.supplierTimeoutMs + 15000),
          signal,
          fetchImpl,
          provider: ID,
        });
        if (status !== 200 && status !== 201) throw classify(status, json, headers);
        return { ...parseDuffelResponse(json, { date, fetchedAt, expectedMode: mode }), fetchedAt, googleFlightsUrl: null };
      }, { retries: 2, baseDelayMs: 2000, signal });
    },
  };
}
