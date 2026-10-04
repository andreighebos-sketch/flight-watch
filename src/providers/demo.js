import { describeAirport } from '../airports.js';
import { localToUtcIso, utcToLocal } from '../dates.js';
import { finalizeOffer } from '../normalize.js';

/**
 * DEMO provider — synthetic itineraries for UI development and tests ONLY.
 * Everything it returns is tagged dataMode "demo", uses the fictional carriers
 * "DEMO Air …", has no booking link and is stored separately from live data.
 */
const ID = 'demo';
const TZ = {
  RMO: 'Europe/Chisinau', IST: 'Europe/Istanbul', OTP: 'Europe/Bucharest', WAW: 'Europe/Warsaw', VIE: 'Europe/Vienna',
  DXB: 'Asia/Dubai', DOH: 'Asia/Qatar', BKK: 'Asia/Bangkok', KUL: 'Asia/Kuala_Lumpur', SGN: 'Asia/Ho_Chi_Minh',
  HAN: 'Asia/Ho_Chi_Minh', CXR: 'Asia/Ho_Chi_Minh',
};
// [airports, segment minutes, layover minutes, departure hour, base EUR total for 2, carriers]
const TEMPLATES = [
  [['RMO', 'IST', 'CXR'], [125, 650], [215], 6, 1210, ['DA', 'DB']],
  [['RMO', 'IST', 'SGN', 'CXR'], [125, 640, 65], [180, 150], 9, 905, ['DA', 'DA', 'DC']],
  [['RMO', 'IST', 'BKK', 'CXR'], [125, 560, 95], [305, 190], 13, 860, ['DA', 'DB', 'DC']],
  [['RMO', 'OTP', 'DOH', 'SGN', 'CXR'], [60, 290, 425, 65], [140, 220, 125], 7, 790, ['DD', 'DB', 'DB', 'DC']],
  [['RMO', 'WAW', 'DXB', 'HAN', 'CXR'], [110, 380, 370, 110], [160, 520, 175], 15, 745, ['DD', 'DA', 'DA', 'DC']],
  [['RMO', 'VIE', 'DXB', 'KUL', 'SGN', 'CXR'], [105, 340, 410, 115, 65], [145, 600, 240, 160], 11, 702, ['DD', 'DB', 'DA', 'DC', 'DC']],
];
const CARRIERS = { DA: 'DEMO Air Alpha', DB: 'DEMO Air Bravo', DC: 'DEMO Air Charlie', DD: 'DEMO Air Delta' };

function prng(seedText) {
  let h = 2166136261;
  for (const c of seedText) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export function buildDemoOffers(date, { now = new Date() } = {}) {
  const fetchedAt = now.toISOString();
  const bucket = Math.floor(now.getTime() / (5 * 60_000)); // changes every 5 min so demo history moves
  const offers = [];
  TEMPLATES.forEach(([codes, segMin, layMin, hour, base, carriers], t) => {
    const rnd = prng(`${date}|${t}`);
    const drift = prng(`${date}|${t}|${bucket}`);
    const dayFactor = 0.85 + rnd() * 0.4;
    const total = Math.round(base * dayFactor * (0.97 + drift() * 0.06));
    let cursor = Date.parse(localToUtcIso(`${date}T${String(hour).padStart(2, '0')}:${t % 2 ? '35' : '05'}`, TZ.RMO));
    const segments = [];
    for (let i = 0; i < codes.length - 1; i += 1) {
      const depUtc = new Date(cursor).toISOString();
      const arrUtc = new Date(cursor + segMin[i] * 60_000).toISOString();
      const code = carriers[i];
      segments.push({
        origin: describeAirport(codes[i]),
        destination: describeAirport(codes[i + 1]),
        departureLocal: utcToLocal(depUtc, TZ[codes[i]]),
        arrivalLocal: utcToLocal(arrUtc, TZ[codes[i + 1]]),
        departureTz: TZ[codes[i]],
        arrivalTz: TZ[codes[i + 1]],
        departureUtc: depUtc,
        arrivalUtc: arrUtc,
        durationMin: segMin[i],
        airline: { name: CARRIERS[code], code, logo: null },
        operatingAirline: null,
        flightNumber: `${code}${100 + t * 10 + i}`,
        aircraft: null,
        cabin: 'Economy',
        overnight: false,
        notes: [],
      });
      cursor += (segMin[i] + (layMin[i] ?? 0)) * 60_000;
    }
    offers.push(finalizeOffer({
      id: `demo_${date}_${t}`,
      source: ID,
      sourceLabel: 'DEMO DATA',
      dataMode: 'demo',
      departureDate: date,
      totalPrice: total,
      currency: 'EUR',
      priceNote: 'DEMO DATA — synthetic price, not a real fare.',
      segments,
      layovers: [],
      bookingUrl: null,
      baggage: [],
      selfTransfer: t === 4,
      notes: ['Synthetic demo itinerary'],
      fetchedAt,
    }));
  });
  return offers;
}

export function createDemoProvider() {
  return {
    id: ID,
    label: 'DEMO DATA',
    dataMode: 'demo',
    website: null,
    isConfigured: true,
    setupHelp: null,
    async searchDate(date) {
      await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
      const fetchedAt = new Date().toISOString();
      return { offers: buildDemoOffers(date), skipped: 0, fetchedAt, providerUpdatedAt: fetchedAt, googleFlightsUrl: null };
    },
  };
}
