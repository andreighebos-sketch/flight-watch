import { createHash } from 'node:crypto';
import { SEARCH } from './constants.js';
import { minutesBetween } from './dates.js';

export const roundMoney = (v) => Math.round(v * 100) / 100;

/** Accepts provider amounts as number or decimal string; returns a finite number ≥ 0 or null. */
export function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? roundMoney(n) : null;
}

/**
 * Average price per passenger, derived from the TOTAL for all passengers.
 * (Providers return one total for the whole group; we never multiply a per-person fare.)
 */
export function pricePerPassenger(total, adults = SEARCH.adults) {
  if (!Number.isFinite(total) || !Number.isInteger(adults) || adults < 1) return null;
  return roundMoney(total / adults);
}

/** "TK 269", "tk0269" → "TK269". Returns null when no usable number. */
export function normalizeFlightNumber(carrierCode, number) {
  const raw = `${carrierCode || ''}${number || ''}`.toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z0-9]{2}[A-Z]?)?0*(\d{1,4}[A-Z]?)$/.exec(raw);
  if (!m) return raw || null;
  return `${m[1] || ''}${m[2]}`;
}

/**
 * Stable itinerary identity, independent of provider offer IDs:
 * departure date + every segment's airports, carrier, flight number and local times.
 */
export function routeFingerprint(offer) {
  const parts = [offer.departureDate];
  for (const s of offer.segments) {
    parts.push([s.origin.iata, s.destination.iata, s.airline.code || s.airline.name || '', s.flightNumber || '', s.departureLocal, s.arrivalLocal].join('|'));
  }
  return createHash('sha1').update(parts.join('>')).digest('hex');
}

const IATA = /^[A-Z]{3}$/;

/**
 * Validates a provider-built draft and completes derived fields. Throws on
 * anything that cannot be shown truthfully (missing price, broken segments…).
 */
export function finalizeOffer(draft, { adults = SEARCH.adults } = {}) {
  const totalPrice = parseMoney(draft.totalPrice);
  if (totalPrice === null || totalPrice <= 0) throw new Error('offer without a valid total price');
  if (!/^[A-Z]{3}$/.test(String(draft.currency || ''))) throw new Error('offer without a valid currency');
  if (!Array.isArray(draft.segments) || draft.segments.length === 0) throw new Error('offer without segments');
  for (const s of draft.segments) {
    if (!IATA.test(s.origin?.iata || '') || !IATA.test(s.destination?.iata || '')) throw new Error('segment with invalid airport code');
    if (!s.departureLocal || !s.arrivalLocal) throw new Error('segment without times');
  }
  const segments = draft.segments;
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first.origin.iata !== SEARCH.origin || last.destination.iata !== SEARCH.destination) {
    throw new Error(`itinerary ${first.origin.iata}→${last.destination.iata} does not match ${SEARCH.origin}→${SEARCH.destination}`);
  }

  const layovers = segments.slice(0, -1).map((s, i) => {
    const next = segments[i + 1];
    const given = draft.layovers?.[i];
    let durationMin = Number.isFinite(given?.durationMin) ? given.durationMin : null;
    if (durationMin === null && s.arrivalUtc && next.departureUtc) durationMin = minutesBetween(s.arrivalUtc, next.departureUtc);
    return {
      airport: s.destination,
      durationMin,
      overnight: Boolean(given?.overnight),
      changeOfAirport: s.destination.iata !== next.origin.iata ? next.origin : null,
    };
  });

  let totalDurationMin = Number.isFinite(draft.totalDurationMin) ? draft.totalDurationMin : null;
  if (totalDurationMin === null && first.departureUtc && last.arrivalUtc) totalDurationMin = minutesBetween(first.departureUtc, last.arrivalUtc);

  const airlines = [...new Set(segments.map((s) => s.airline.name || s.airline.code).filter(Boolean))];
  const offer = {
    id: String(draft.id),
    source: draft.source,
    sourceLabel: draft.sourceLabel,
    dataMode: draft.dataMode,
    departureDate: draft.departureDate,
    totalPrice,
    currency: draft.currency,
    pricePerPerson: pricePerPassenger(totalPrice, adults),
    passengers: adults,
    priceNote: draft.priceNote || null,
    baseFare: parseMoney(draft.baseFare),
    taxes: parseMoney(draft.taxes),
    original: null,
    fx: null,
    departureLocal: first.departureLocal,
    arrivalLocal: last.arrivalLocal,
    departureUtc: first.departureUtc || null,
    arrivalUtc: last.arrivalUtc || null,
    totalDurationMin,
    stops: segments.length - 1,
    segments,
    layovers,
    airlines,
    origin: first.origin,
    destination: last.destination,
    bookingUrl: draft.bookingUrl || null,
    bookingLinkKind: draft.bookingUrl ? draft.bookingLinkKind || 'search' : null,
    baggage: draft.baggage?.length ? draft.baggage : null,
    selfTransfer: Boolean(draft.selfTransfer),
    notes: draft.notes || [],
    expiresAt: draft.expiresAt || null,
    fetchedAt: draft.fetchedAt,
    providerUpdatedAt: draft.providerUpdatedAt || draft.fetchedAt,
  };
  offer.fingerprint = routeFingerprint(offer);
  return offer;
}

/** Same itinerary returned several times (e.g. different fare brands): keep the cheapest. */
export function dedupeCheapest(offers) {
  const best = new Map();
  for (const o of offers) {
    const cur = best.get(o.fingerprint);
    if (!cur || o.totalPrice < cur.totalPrice) best.set(o.fingerprint, o);
  }
  return [...best.values()];
}
