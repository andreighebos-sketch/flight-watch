import { ErrorKind, ProviderError, fetchJson } from './http.js';

/**
 * EUR conversion using the Frankfurter API (European Central Bank reference
 * rates, free, no key): https://frankfurter.dev
 * Used only when a provider returns a currency other than EUR.
 */
export const FX_ENDPOINT = 'https://api.frankfurter.dev/v1/latest';

export function createCurrencyConverter({ fetchImpl = fetch, ttlMs = 6 * 3600_000, timeoutMs = 10000 } = {}) {
  const cache = new Map();

  async function rateToEur(currency) {
    const code = String(currency || '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new ProviderError(`Invalid currency "${currency}"`, { kind: ErrorKind.INVALID_RESPONSE });
    if (code === 'EUR') return { rate: 1, date: null, source: null };
    const hit = cache.get(code);
    if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit.value;
    const url = `${FX_ENDPOINT}?from=${encodeURIComponent(code)}&to=EUR`;
    const { status, json } = await fetchJson(url, { timeoutMs, fetchImpl, provider: 'frankfurter' });
    const rate = json?.rates?.EUR;
    if (status !== 200 || typeof rate !== 'number' || !(rate > 0)) {
      throw new ProviderError(`No ECB exchange rate available for ${code}`, { kind: ErrorKind.INVALID_RESPONSE, status });
    }
    const value = { rate, date: typeof json.date === 'string' ? json.date : null, source: 'ECB reference rate via Frankfurter' };
    cache.set(code, { value, fetchedAt: Date.now() });
    return value;
  }

  return {
    rateToEur,
    /** Mutates offers in place: converts non-EUR prices or marks them as unconverted. */
    async convertOffers(offers) {
      for (const offer of offers) {
        if (offer.currency === 'EUR') continue;
        try {
          const fx = await rateToEur(offer.currency);
          const round = (v) => (v == null ? null : Math.round(v * fx.rate * 100) / 100);
          offer.original = { totalPrice: offer.totalPrice, currency: offer.currency };
          offer.fx = { rate: fx.rate, date: fx.date, source: fx.source };
          offer.totalPrice = round(offer.totalPrice);
          offer.pricePerPerson = round(offer.pricePerPerson);
          offer.baseFare = round(offer.baseFare);
          offer.taxes = round(offer.taxes);
          offer.currency = 'EUR';
        } catch {
          offer.fx = { rate: null, date: null, source: null, unavailable: true };
        }
      }
      return offers;
    },
  };
}
