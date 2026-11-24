/**
 * Password rotation ("renew every N days/weeks/months/years"). Pure logic shared
 * by the main process and the renderer.
 *
 * Rotation is stored inside the entry itself, as regular `key: value` lines, so
 * that it travels with the store and stays readable by `pass` and other clients:
 *
 *     rotation: 2m
 *     password-changed: 2026-11-24
 *     change-url: https://example.org/account/password
 */
export const ROTATION_KEY = 'rotation';
export const CHANGED_KEY = 'password-changed';
export const CHANGE_URL_KEY = 'change-url';
export const ROTATION_KEYS: readonly string[] = [ROTATION_KEY, CHANGED_KEY, CHANGE_URL_KEY];

export type IntervalUnit = 'd' | 'w' | 'm' | 'y';
export interface RotationInterval {
  readonly count: number;
  readonly unit: IntervalUnit;
}

export type RotationState = 'ok' | 'soon' | 'expired';

export interface RotationStatus {
  /** ISO date (YYYY-MM-DD) of the deadline, null when the last change is unknown. */
  readonly dueAt: string | null;
  /** Whole days until the deadline (negative once expired), null when unknown. */
  readonly daysLeft: number | null;
  readonly state: RotationState;
}

const DAY_MS = 86_400_000;
const INTERVAL_PATTERN = /^(\d{1,4})\s*([dwmy])$/i;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parses `60d`, `8w`, `2m`, `1y` (case-insensitive). */
export function parseInterval(value: string): RotationInterval | null {
  const match = INTERVAL_PATTERN.exec(value.trim());
  const count = Number(match?.[1]);
  const unit = match?.[2]?.toLowerCase();
  if (unit !== 'd' && unit !== 'w' && unit !== 'm' && unit !== 'y') return null;
  return count >= 1 ? { count, unit } : null;
}

export function formatInterval(interval: RotationInterval): string {
  return `${String(interval.count)}${interval.unit}`;
}

/** Parses a `YYYY-MM-DD` calendar date (UTC); rejects impossible dates such as 2026-02-30. */
export function parseDate(value: string): Date | null {
  const match = DATE_PATTERN.exec(value.trim());
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date : null;
}

export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's calendar date in UTC, as written in `password-changed:`. */
export function today(nowMs: number): string {
  return formatDate(new Date(nowMs));
}

/** Adds an interval; months/years keep the day of month, clamped to the month's last day. */
export function addInterval(date: Date, interval: RotationInterval): Date {
  if (interval.unit === 'd' || interval.unit === 'w') {
    const days = interval.count * (interval.unit === 'w' ? 7 : 1);
    return new Date(date.getTime() + days * DAY_MS);
  }
  const months = interval.count * (interval.unit === 'y' ? 12 : 1);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

/**
 * Where a password stands. A rotated entry whose last change is unknown (for
 * example `rotation:` added with `pass edit`) is considered expired: the user
 * is asked to renew it, which records the date.
 */
export function rotationStatus(
  interval: RotationInterval,
  changedAt: string | null,
  nowMs: number,
  warningDays: number,
): RotationStatus {
  const changed = changedAt === null ? null : parseDate(changedAt);
  if (changed === null) return { dueAt: null, daysLeft: null, state: 'expired' };
  const due = addInterval(changed, interval);
  const todayMs = parseDate(today(nowMs))?.getTime() ?? nowMs;
  const daysLeft = Math.round((due.getTime() - todayMs) / DAY_MS);
  const state: RotationState = daysLeft <= 0 ? 'expired' : daysLeft <= warningDays ? 'soon' : 'ok';
  return { dueAt: formatDate(due), daysLeft, state };
}

/** Rotation presets offered in the UI (custom values remain possible). */
export const ROTATION_PRESETS: readonly string[] = ['1m', '2m', '3m', '6m', '1y'];
