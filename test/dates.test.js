import { describe, expect, it } from 'vitest';
import { formatDuration, generateDateRange, isIsoDate, localToUtcIso, parseIsoDurationToMinutes, utcToLocal } from '../src/dates.js';
import { SEARCH } from '../src/constants.js';

describe('date range generation', () => {
  it('covers 20 Oct – 15 Nov 2026 inclusive (27 departure dates)', () => {
    const dates = generateDateRange(SEARCH.startDate, SEARCH.endDate);
    expect(dates).toHaveLength(27);
    expect(dates[0]).toBe('2026-10-20');
    expect(dates.at(-1)).toBe('2026-11-15');
    expect(dates).toContain('2026-10-31');
    expect(dates).toContain('2026-11-01');
    expect(new Set(dates).size).toBe(27);
  });
  it('is not affected by the DST change on 25 Oct 2026', () => {
    const dates = generateDateRange('2026-10-24', '2026-10-26');
    expect(dates).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
  });
  it('rejects invalid input', () => {
    expect(() => generateDateRange('2026-11-15', '2026-10-20')).toThrow();
    expect(() => generateDateRange('2026-02-30', '2026-03-01')).toThrow();
    expect(isIsoDate('2026-10-20')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });
});

describe('durations and time zones', () => {
  it('parses ISO-8601 durations from providers', () => {
    expect(parseIsoDurationToMinutes('PT2H26M')).toBe(146);
    expect(parseIsoDurationToMinutes('P1DT2H5M')).toBe(1565);
    expect(parseIsoDurationToMinutes('PT45M')).toBe(45);
    expect(parseIsoDurationToMinutes('garbage')).toBeNull();
    expect(formatDuration(1565)).toBe('26h 05m');
  });
  it('converts airport-local times to UTC using IANA zones (incl. DST)', () => {
    // Chișinău is UTC+3 until 25 Oct 2026 and UTC+2 afterwards.
    expect(localToUtcIso('2026-10-20T06:15', 'Europe/Chisinau')).toBe('2026-10-20T03:15:00.000Z');
    expect(localToUtcIso('2026-11-02T06:15', 'Europe/Chisinau')).toBe('2026-11-02T04:15:00.000Z');
    expect(localToUtcIso('2026-10-21 10:40', 'Asia/Ho_Chi_Minh')).toBe('2026-10-21T03:40:00.000Z');
    expect(utcToLocal('2026-10-21T03:40:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('2026-10-21T10:40');
  });
});
