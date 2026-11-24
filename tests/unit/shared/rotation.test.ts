import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addInterval,
  formatDate,
  formatInterval,
  parseDate,
  parseInterval,
  rotationStatus,
  today,
} from '../../../src/shared/rotation';

const date = (value: string): Date => {
  const parsed = parseDate(value);
  if (parsed === null) throw new Error(`bad date ${value}`);
  return parsed;
};
const at = (value: string): number => date(value).getTime() + 13 * 3_600_000;

describe('intervals', () => {
  it('parses days, weeks, months and years', () => {
    expect(parseInterval('60d')).toEqual({ count: 60, unit: 'd' });
    expect(parseInterval(' 8 W ')).toEqual({ count: 8, unit: 'w' });
    expect(parseInterval('2m')).toEqual({ count: 2, unit: 'm' });
    expect(parseInterval('1Y')).toEqual({ count: 1, unit: 'y' });
    for (const bad of ['', '0d', '-1m', '2 months', 'm', '12345d', '1.5m', '2x']) {
      expect(parseInterval(bad)).toBeNull();
    }
    expect(formatInterval({ count: 3, unit: 'm' })).toBe('3m');
  });

  it('parses only real calendar dates', () => {
    expect(formatDate(date('2026-11-24'))).toBe('2026-11-24');
    expect(parseDate('2026-02-30')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('24/11/2026')).toBeNull();
    expect(parseDate(' 2024-02-29 ')).not.toBeNull();
    expect(today(Date.UTC(2026, 10, 24, 23, 59))).toBe('2026-11-24');
  });

  it('adds months like a calendar, clamping to the end of the month', () => {
    expect(formatDate(addInterval(date('2026-11-24'), { count: 2, unit: 'm' }))).toBe('2027-01-24');
    expect(formatDate(addInterval(date('2026-12-31'), { count: 2, unit: 'm' }))).toBe('2027-02-28');
    expect(formatDate(addInterval(date('2024-02-29'), { count: 1, unit: 'y' }))).toBe('2025-02-28');
    expect(formatDate(addInterval(date('2026-01-31'), { count: 1, unit: 'm' }))).toBe('2026-02-28');
    expect(formatDate(addInterval(date('2026-11-24'), { count: 60, unit: 'd' }))).toBe(
      '2027-01-23',
    );
    expect(formatDate(addInterval(date('2026-11-24'), { count: 2, unit: 'w' }))).toBe('2026-12-08');
  });

  it('property: the deadline is always after the change date', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }),
        fc.integer({ min: 1, max: 400 }),
        fc.constantFrom('d', 'w', 'm', 'y'),
        (start, count, unit) => {
          const day = date(formatDate(start));
          expect(addInterval(day, { count, unit }).getTime()).toBeGreaterThan(day.getTime());
        },
      ),
      { numRuns: 500, seed: 11 },
    );
  });
});

describe('rotationStatus', () => {
  const every2m = { count: 2, unit: 'm' } as const;

  it('reports ok, soon and expired around the deadline', () => {
    expect(rotationStatus(every2m, '2026-11-24', at('2026-11-24'), 7)).toEqual({
      dueAt: '2027-01-24',
      daysLeft: 61,
      state: 'ok',
    });
    expect(rotationStatus(every2m, '2026-11-24', at('2027-01-17'), 7)).toEqual({
      dueAt: '2027-01-24',
      daysLeft: 7,
      state: 'soon',
    });
    expect(rotationStatus(every2m, '2026-11-24', at('2027-01-24'), 7).state).toBe('expired');
    expect(rotationStatus(every2m, '2026-11-24', at('2027-03-01'), 7)).toEqual({
      dueAt: '2027-01-24',
      daysLeft: -36,
      state: 'expired',
    });
    expect(rotationStatus(every2m, '2026-11-24', at('2027-01-17'), 0).state).toBe('ok');
  });

  it('treats an unknown or invalid change date as expired', () => {
    const expired = { dueAt: null, daysLeft: null, state: 'expired' };
    expect(rotationStatus(every2m, null, at('2026-11-24'), 7)).toEqual(expired);
    expect(rotationStatus(every2m, 'yesterday', at('2026-11-24'), 7)).toEqual(expired);
  });
});
