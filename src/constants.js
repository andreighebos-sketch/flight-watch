/**
 * The fixed search this monitor is built for. Everything is validated against
 * these values so that the server can never be turned into a generic proxy.
 *
 * Airport codes (verified):
 *  - RMO: Eugen Doga Chișinău International Airport. IATA changed the code from
 *    KIV to RMO on 18 January 2024; KIV is no longer the airport's code.
 *  - CXR: Cam Ranh International Airport, the commercial airport serving Nha Trang.
 *    "NHA" is the former Nha Trang airfield, which has no scheduled passenger service.
 */
export const SEARCH = Object.freeze({
  origin: 'RMO',
  destination: 'CXR',
  originLabel: 'Chișinău',
  destinationLabel: 'Nha Trang',
  startDate: '2026-10-20',
  endDate: '2026-11-15',
  adults: 2,
  tripType: 'one_way',
  cabin: 'economy',
  currency: 'EUR',
});

export const ROUTE_KEY = `${SEARCH.origin}-${SEARCH.destination}-OW-${SEARCH.adults}ADT-ECONOMY`;
