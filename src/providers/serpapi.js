import { SEARCH } from '../constants.js';
import { describeAirport } from '../airports.js';
import { normalizeLocalDateTime } from '../dates.js';
import { ErrorKind, ProviderError, fetchJson, withRetry } from '../http.js';
import { finalizeOffer, normalizeFlightNumber } from '../normalize.js';

/**
 * SerpApi — Google Flights API (https://serpapi.com/google-flights-api).
 * GET https://serpapi.com/search.json?engine=google_flights&type=2&departure_id=…&arrival_id=…
 * One request = one departure date. `price` is the Google Flights price for the
 * whole passenger group requested via `adults`, in `currency`, incl. taxes.
 */
export const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';
const ID = 'serpapi';
const LABEL = 'SerpApi · Google Flights';

export function buildSerpApiParams(date, cfg) {
  const p = new URLSearchParams({
    engine: 'google_flights',
    type: '2', // one way
    departure_id: SEARCH.origin,
    arrival_id: SEARCH.destination,
    outbound_date: date,
    adults: String(SEARCH.adults),
    travel_class: '1', // economy
    currency: SEARCH.currency,
    hl: cfg.hl,
    gl: cfg.gl,
    sort_by: '2', // price
    show_hidden: 'true', // include "View more flights" results — more cheap multi-stop options
  });
  // `stops` is intentionally omitted: SerpApi default 0 = any number of stops.
  if (cfg.deepSearch) p.set('deep_search', 'true');
  return p;
}

const NO_RESULTS = /hasn'?t returned any results|no results/i;

function parseUtcStamp(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function carrierCodeFrom(flightNumber) {
  const m = /^([A-Z0-9]{2})\s?\d/.exec(String(flightNumber || '').toUpperCase());
  return m ? m[1] : null;
}

/** Converts one SerpApi result item into a normalized FlightOffer (or throws). */
export function serpItemToOffer(item, ctx) {
  if (!item || !Array.isArray(item.flights) || item.flights.length === 0) throw new Error('item without flights');
  const cities = ctx.cities || {};
  const segments = item.flights.map((f) => {
    const dep = f.departure_airport || {};
    const arr = f.arrival_airport || {};
    const code = carrierCodeFrom(f.flight_number);
    return {
      origin: describeAirport(dep.id, dep.name, cities[dep.id]),
      destination: describeAirport(arr.id, arr.name, cities[arr.id]),
      departureLocal: normalizeLocalDateTime(dep.time),
      arrivalLocal: normalizeLocalDateTime(arr.time),
      departureUtc: null, // Google Flights returns local wall-clock times without offsets
      arrivalUtc: null,
      durationMin: Number.isFinite(f.duration) ? f.duration : null,
      airline: { name: typeof f.airline === 'string' ? f.airline : null, code, logo: typeof f.airline_logo === 'string' ? f.airline_logo : null },
      operatingAirline: null,
      flightNumber: f.flight_number ? normalizeFlightNumber(null, f.flight_number) : null,
      aircraft: typeof f.airplane === 'string' ? f.airplane : null,
      cabin: typeof f.travel_class === 'string' ? f.travel_class : null,
      overnight: Boolean(f.overnight),
      notes: Array.isArray(f.extensions) ? f.extensions.filter((x) => typeof x === 'string') : [],
    };
  });
  const layovers = Array.isArray(item.layovers)
    ? item.layovers.map((l) => ({ durationMin: Number.isFinite(l?.duration) ? l.duration : null, overnight: Boolean(l?.overnight) }))
    : [];
  const ext = Array.isArray(item.extensions) ? item.extensions.filter((x) => typeof x === 'string') : [];
  const segText = segments.flatMap((s) => s.notes);
  const allText = [...ext, ...segText];
  const baggage = allText.filter((t) => /bag|luggage/i.test(t));
  // Only flag self-transfer when Google explicitly says so.
  const selfTransfer = allText.some((t) => /self[\s-]?transfer|separate tickets/i.test(t));

  return finalizeOffer({
    id: `serp_${ctx.date}_${ctx.index}`,
    source: ID,
    sourceLabel: LABEL,
    dataMode: 'live',
    departureDate: ctx.date,
    totalPrice: item.price,
    currency: ctx.currency,
    priceNote: 'Google Flights total for 2 adults incl. taxes & carrier-imposed fees; optional extras (bags, seats, card fees) not included.',
    totalDurationMin: Number.isFinite(item.total_duration) ? item.total_duration : null,
    segments,
    layovers,
    bookingUrl: ctx.googleFlightsUrl,
    bookingLinkKind: 'search',
    baggage,
    selfTransfer,
    notes: ext.filter((t) => !baggage.includes(t)),
    fetchedAt: ctx.fetchedAt,
    providerUpdatedAt: ctx.providerUpdatedAt,
  });
}

/** Validates a SerpApi response body and returns normalized offers. */
export function parseSerpApiResponse(json, { date, fetchedAt }) {
  if (!json || typeof json !== 'object') {
    throw new ProviderError('SerpApi returned a non-JSON response', { kind: ErrorKind.INVALID_RESPONSE, provider: ID });
  }
  const meta = json.search_metadata || {};
  if (json.error) {
    if (NO_RESULTS.test(json.error)) return { offers: [], skipped: 0, providerUpdatedAt: parseUtcStamp(meta.processed_at) || fetchedAt, googleFlightsUrl: meta.google_flights_url || null };
    throw new ProviderError(`SerpApi: ${json.error}`, { kind: ErrorKind.SERVER, provider: ID });
  }
  if (meta.status && meta.status !== 'Success') {
    throw new ProviderError(`SerpApi search status: ${meta.status}`, { kind: ErrorKind.SERVER, retryable: true, provider: ID });
  }
  const currency = String(json.search_parameters?.currency || SEARCH.currency).toUpperCase();
  const adults = Number(json.search_parameters?.adults ?? SEARCH.adults);
  if (adults !== SEARCH.adults) {
    throw new ProviderError(`SerpApi answered for ${adults} adult(s) instead of ${SEARCH.adults}`, { kind: ErrorKind.INVALID_RESPONSE, provider: ID });
  }
  const googleFlightsUrl = typeof meta.google_flights_url === 'string' && meta.google_flights_url.startsWith('https://www.google.com/') ? meta.google_flights_url : null;
  const providerUpdatedAt = parseUtcStamp(meta.processed_at) || parseUtcStamp(meta.created_at) || fetchedAt;
  const cities = {};
  for (const group of Array.isArray(json.airports) ? json.airports : []) {
    for (const a of [...(group.departure || []), ...(group.arrival || [])]) {
      if (a?.airport?.id && a.city) cities[a.airport.id] = a.city;
    }
  }
  const items = [...(Array.isArray(json.best_flights) ? json.best_flights : []), ...(Array.isArray(json.other_flights) ? json.other_flights : [])];
  const offers = [];
  let skipped = 0;
  items.forEach((item, index) => {
    try {
      offers.push(serpItemToOffer(item, { date, index, currency, fetchedAt, providerUpdatedAt, googleFlightsUrl, cities }));
    } catch {
      skipped += 1; // e.g. "price unavailable" items or malformed segments
    }
  });
  return { offers, skipped, providerUpdatedAt, googleFlightsUrl };
}

function classify(status, json) {
  const msg = json?.error || `HTTP ${status}`;
  if (status === 401 || status === 403) return new ProviderError(`SerpApi rejected the API key: ${msg}`, { kind: ErrorKind.AUTH, status, provider: ID });
  if (status === 429) {
    const quota = /run out|plan|searches per month|monthly/i.test(msg);
    return new ProviderError(`SerpApi rate limit: ${msg}`, { kind: quota ? ErrorKind.QUOTA : ErrorKind.RATE_LIMIT, status, provider: ID });
  }
  if (status >= 500) return new ProviderError(`SerpApi server error: ${msg}`, { kind: ErrorKind.SERVER, status, retryable: true, provider: ID });
  return new ProviderError(`SerpApi request failed: ${msg}`, { kind: ErrorKind.BAD_REQUEST, status, provider: ID });
}

export function createSerpApiProvider(cfg, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  return {
    id: ID,
    label: LABEL,
    dataMode: 'live',
    website: 'https://serpapi.com/google-flights-api',
    isConfigured: Boolean(cfg.apiKey),
    setupHelp: {
      envVar: 'SERPAPI_API_KEY',
      steps: [
        'Create a free account at https://serpapi.com/users/sign_up',
        'Copy your private key from https://serpapi.com/manage-api-key',
        'Put SERPAPI_API_KEY=<your key> into .env (FLIGHT_PROVIDER=serpapi) and restart the server.',
      ],
    },
    async searchDate(date, { signal } = {}) {
      if (!cfg.apiKey) throw new ProviderError('SERPAPI_API_KEY is not set', { kind: ErrorKind.CONFIG, provider: ID });
      const params = buildSerpApiParams(date, cfg);
      params.set('api_key', cfg.apiKey); // server-side only
      return withRetry(async () => {
        const fetchedAt = new Date().toISOString();
        const { status, json } = await fetchJson(`${SERPAPI_ENDPOINT}?${params}`, { timeoutMs, signal, fetchImpl, provider: ID });
        if (status !== 200) {
          if (status === 400 && json?.error && NO_RESULTS.test(json.error)) return { offers: [], skipped: 0, providerUpdatedAt: fetchedAt, googleFlightsUrl: null, fetchedAt };
          throw classify(status, json);
        }
        return { ...parseSerpApiResponse(json, { date, fetchedAt }), fetchedAt };
      }, { retries: 2, baseDelayMs: 1500, signal });
    },
  };
}
