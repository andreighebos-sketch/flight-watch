/**
 * Pure, dependency-free offer logic shared by the server and the browser
 * (served read-only at /shared/offer-logic.js). Operates on normalized FlightOffer objects.
 */

/** Price used for ranking. Only EUR totals are comparable; unconverted currencies sort last. */
export function sortPrice(offer) {
  return offer && offer.currency === 'EUR' && Number.isFinite(offer.totalPrice) ? offer.totalPrice : null;
}

const nullsLast = (a, b) => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
};
const byDuration = (a, b) => nullsLast(a.totalDurationMin ?? null, b.totalDurationMin ?? null);
const byDeparture = (a, b) => String(a.departureLocal).localeCompare(String(b.departureLocal));

export function compareCheapest(a, b) {
  return nullsLast(sortPrice(a), sortPrice(b)) || byDuration(a, b) || byDeparture(a, b);
}

export const SORTS = Object.freeze({
  cheapest: compareCheapest,
  fastest: (a, b) => byDuration(a, b) || compareCheapest(a, b),
  fewest_stops: (a, b) => a.stops - b.stops || compareCheapest(a, b),
  earliest: (a, b) => byDeparture(a, b) || compareCheapest(a, b),
});

export function sortOffers(offers, key = 'cheapest') {
  const cmp = SORTS[key] || SORTS.cheapest;
  return [...offers].sort(cmp);
}

export const STOP_FILTERS = Object.freeze(['any', '0', '1', '2', '3', '4plus']);
export const DURATION_FILTERS = Object.freeze(['any', '24', '36', '48', '72']);

/** Filters default to "any": the number of stops is never restricted unless the user asks. */
export function applyFilters(offers, filters = {}) {
  const { stops = 'any', maxDurationH = 'any', airline = 'any', date = 'any', maxPrice = null } = filters;
  const maxMin = maxDurationH !== 'any' && Number(maxDurationH) > 0 ? Number(maxDurationH) * 60 : null;
  const priceCap = maxPrice !== null && maxPrice !== '' && Number(maxPrice) > 0 ? Number(maxPrice) : null;
  return offers.filter((o) => {
    if (stops === '4plus' && o.stops < 4) return false;
    if (stops !== 'any' && stops !== '4plus' && o.stops > Number(stops)) return false;
    if (maxMin !== null && !(o.totalDurationMin != null && o.totalDurationMin <= maxMin)) return false;
    if (airline !== 'any' && !(o.airlines || []).includes(airline)) return false;
    if (date !== 'any' && o.departureDate !== date) return false;
    if (priceCap !== null) {
      const p = sortPrice(o);
      if (p === null || p > priceCap) return false;
    }
    return true;
  });
}

export function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round(((v[mid - 1] + v[mid]) / 2) * 100) / 100;
}

/** Cheapest offer per departure date, for every date of the range (null when none). */
export function cheapestByDate(offers, dates) {
  const best = new Map();
  for (const o of offers) {
    const cur = best.get(o.departureDate);
    if (sortPrice(o) !== null && (!cur || compareCheapest(o, cur) < 0)) best.set(o.departureDate, o);
  }
  return dates.map((date) => {
    const offer = best.get(date) || null;
    return { date, minPrice: offer ? offer.totalPrice : null, offer };
  });
}

/** Best price/duration compromise: min of 0.6·normPrice + 0.4·normDuration. */
export function bestValue(offers) {
  const c = offers.filter((o) => sortPrice(o) !== null && Number.isFinite(o.totalDurationMin));
  if (!c.length) return null;
  const prices = c.map(sortPrice);
  const durs = c.map((o) => o.totalDurationMin);
  const [pMin, pMax, dMin, dMax] = [Math.min(...prices), Math.max(...prices), Math.min(...durs), Math.max(...durs)];
  const norm = (v, lo, hi) => (hi === lo ? 0 : (v - lo) / (hi - lo));
  let best = null;
  let bestScore = Infinity;
  for (const o of c) {
    const score = 0.6 * norm(sortPrice(o), pMin, pMax) + 0.4 * norm(o.totalDurationMin, dMin, dMax);
    if (score < bestScore || (score === bestScore && compareCheapest(o, best) < 0)) {
      best = o;
      bestScore = score;
    }
  }
  return best;
}

export function computeStats(offers) {
  const priced = offers.filter((o) => sortPrice(o) !== null);
  const sorted = sortOffers(priced, 'cheapest');
  return {
    count: offers.length,
    cheapest: sorted[0] || null,
    fastest: sortOffers(priced, 'fastest')[0] || null,
    bestValue: bestValue(priced),
    medianPrice: median(priced.map(sortPrice)),
  };
}
