/**
 * Reference names for the endpoints and frequent hubs on Europe → Vietnam itineraries.
 * Used only to render a friendly "IATA — City" label. When a code is not listed,
 * the airport name returned by the provider is shown instead (never an invented one).
 */
export const AIRPORTS = Object.freeze({
  RMO: { city: 'Chișinău', name: 'Eugen Doga Chișinău International Airport', country: 'MD' },
  CXR: { city: 'Cam Ranh / Nha Trang', name: 'Cam Ranh International Airport', country: 'VN' },
  IST: { city: 'Istanbul', name: 'Istanbul Airport', country: 'TR' },
  SAW: { city: 'Istanbul', name: 'Istanbul Sabiha Gökçen International Airport', country: 'TR' },
  OTP: { city: 'Bucharest', name: 'Henri Coandă International Airport', country: 'RO' },
  IAS: { city: 'Iași', name: 'Iași International Airport', country: 'RO' },
  WAW: { city: 'Warsaw', name: 'Warsaw Chopin Airport', country: 'PL' },
  VIE: { city: 'Vienna', name: 'Vienna International Airport', country: 'AT' },
  BUD: { city: 'Budapest', name: 'Budapest Ferenc Liszt International Airport', country: 'HU' },
  FRA: { city: 'Frankfurt', name: 'Frankfurt Airport', country: 'DE' },
  MUC: { city: 'Munich', name: 'Munich Airport', country: 'DE' },
  CDG: { city: 'Paris', name: 'Paris Charles de Gaulle Airport', country: 'FR' },
  AMS: { city: 'Amsterdam', name: 'Amsterdam Airport Schiphol', country: 'NL' },
  LHR: { city: 'London', name: 'Heathrow Airport', country: 'GB' },
  FCO: { city: 'Rome', name: 'Leonardo da Vinci–Fiumicino Airport', country: 'IT' },
  MXP: { city: 'Milan', name: 'Milan Malpensa Airport', country: 'IT' },
  ATH: { city: 'Athens', name: 'Athens International Airport', country: 'GR' },
  SOF: { city: 'Sofia', name: 'Sofia Airport', country: 'BG' },
  LCA: { city: 'Larnaca', name: 'Larnaca International Airport', country: 'CY' },
  TLV: { city: 'Tel Aviv', name: 'Ben Gurion Airport', country: 'IL' },
  DXB: { city: 'Dubai', name: 'Dubai International Airport', country: 'AE' },
  SHJ: { city: 'Sharjah', name: 'Sharjah International Airport', country: 'AE' },
  AUH: { city: 'Abu Dhabi', name: 'Zayed International Airport', country: 'AE' },
  DOH: { city: 'Doha', name: 'Hamad International Airport', country: 'QA' },
  MCT: { city: 'Muscat', name: 'Muscat International Airport', country: 'OM' },
  BAH: { city: 'Manama', name: 'Bahrain International Airport', country: 'BH' },
  KWI: { city: 'Kuwait City', name: 'Kuwait International Airport', country: 'KW' },
  JED: { city: 'Jeddah', name: 'King Abdulaziz International Airport', country: 'SA' },
  RUH: { city: 'Riyadh', name: 'King Khalid International Airport', country: 'SA' },
  TBS: { city: 'Tbilisi', name: 'Tbilisi International Airport', country: 'GE' },
  EVN: { city: 'Yerevan', name: 'Zvartnots International Airport', country: 'AM' },
  GYD: { city: 'Baku', name: 'Heydar Aliyev International Airport', country: 'AZ' },
  TAS: { city: 'Tashkent', name: 'Tashkent International Airport', country: 'UZ' },
  ALA: { city: 'Almaty', name: 'Almaty International Airport', country: 'KZ' },
  DEL: { city: 'Delhi', name: 'Indira Gandhi International Airport', country: 'IN' },
  BOM: { city: 'Mumbai', name: 'Chhatrapati Shivaji Maharaj International Airport', country: 'IN' },
  CMB: { city: 'Colombo', name: 'Bandaranaike International Airport', country: 'LK' },
  BKK: { city: 'Bangkok', name: 'Suvarnabhumi Airport', country: 'TH' },
  DMK: { city: 'Bangkok', name: 'Don Mueang International Airport', country: 'TH' },
  KUL: { city: 'Kuala Lumpur', name: 'Kuala Lumpur International Airport', country: 'MY' },
  SIN: { city: 'Singapore', name: 'Singapore Changi Airport', country: 'SG' },
  SGN: { city: 'Ho Chi Minh City', name: 'Tan Son Nhat International Airport', country: 'VN' },
  HAN: { city: 'Hanoi', name: 'Noi Bai International Airport', country: 'VN' },
  DAD: { city: 'Da Nang', name: 'Da Nang International Airport', country: 'VN' },
  HKG: { city: 'Hong Kong', name: 'Hong Kong International Airport', country: 'HK' },
  TPE: { city: 'Taipei', name: 'Taiwan Taoyuan International Airport', country: 'TW' },
  ICN: { city: 'Seoul', name: 'Incheon International Airport', country: 'KR' },
  CAN: { city: 'Guangzhou', name: 'Guangzhou Baiyun International Airport', country: 'CN' },
  PVG: { city: 'Shanghai', name: 'Shanghai Pudong International Airport', country: 'CN' },
  PEK: { city: 'Beijing', name: 'Beijing Capital International Airport', country: 'CN' },
  PKX: { city: 'Beijing', name: 'Beijing Daxing International Airport', country: 'CN' },
});

/** Returns { iata, city, name } using provider data as fallback, never inventing names. */
export function describeAirport(iata, providerName = null, providerCity = null) {
  const code = String(iata || '').toUpperCase();
  const known = AIRPORTS[code];
  return {
    iata: code,
    city: known?.city ?? providerCity ?? null,
    name: providerName || known?.name || null,
  };
}
