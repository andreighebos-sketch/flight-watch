const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === value;
}

/** Inclusive list of calendar dates (YYYY-MM-DD) between start and end. */
export function generateDateRange(start, end) {
  if (!isIsoDate(start) || !isIsoDate(end)) throw new Error('Dates must be valid YYYY-MM-DD');
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (to < from) throw new Error('End date is before start date');
  const days = Math.round((to - from) / DAY_MS) + 1;
  if (days > 366) throw new Error('Date range too long');
  return Array.from({ length: days }, (_, i) => new Date(from + i * DAY_MS).toISOString().slice(0, 10));
}

/** "PT1H30M", "P1DT2H5M", "PT45M" → minutes. Returns null when unparseable. */
export function parseIsoDurationToMinutes(value) {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!m || value.trim() === 'P' || value.trim() === 'PT') return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Number(d) * 1440 + Number(h) * 60 + Number(min) + Math.round(Number(s) / 60);
}

/** Normalizes "2026-10-28 06:15" or "2026-10-28T06:15:00" to "2026-10-28T06:15". */
export function normalizeLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(value.trim());
  if (!m || !isIsoDate(m[1])) return null;
  if (+m[2] > 23 || +m[3] > 59) return null;
  return `${m[1]}T${m[2]}:${m[3]}`;
}

/** Offset (minutes, east of UTC positive) of an IANA zone at a UTC instant. */
export function tzOffsetMinutes(utcMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** Converts a wall-clock time in an IANA zone into a UTC ISO timestamp. */
export function localToUtcIso(local, timeZone) {
  const norm = normalizeLocalDateTime(local);
  if (!norm || !timeZone) return null;
  try {
    const [date, time] = norm.split('T');
    const [y, mo, d] = date.split('-').map(Number);
    const [h, mi] = time.split(':').map(Number);
    const guess = Date.UTC(y, mo - 1, d, h, mi);
    const off1 = tzOffsetMinutes(guess, timeZone);
    let utc = guess - off1 * 60000;
    const off2 = tzOffsetMinutes(utc, timeZone);
    if (off2 !== off1) utc = guess - off2 * 60000;
    return new Date(utc).toISOString();
  } catch {
    return null;
  }
}

/** Wall-clock time in a zone for a UTC instant, formatted "YYYY-MM-DDTHH:mm". */
export function utcToLocal(utcIso, timeZone) {
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) return null;
  const shifted = new Date(ms + tzOffsetMinutes(ms, timeZone) * 60000);
  return shifted.toISOString().slice(0, 16);
}

export function minutesBetween(startIso, endIso) {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60000);
}

export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function utcDayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
