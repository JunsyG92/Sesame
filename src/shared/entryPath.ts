import { err, ok, type Result } from './result';

/**
 * Pure validation of entry names (the `pass` "pass-name"), shared by the main
 * process (authoritative) and the renderer (live feedback).
 */
export const PATH_ERROR_REASONS = [
  'empty',
  'absolute',
  'traversal',
  'empty-segment',
  'hidden-segment',
  'forbidden-character',
  'reserved-name',
  'trailing-dot-or-space',
  'too-long',
] as const;
export type PathErrorReason = (typeof PATH_ERROR_REASONS)[number];

export type PathMode = 'existing' | 'new';

export const MAX_PATH_LENGTH = 512;
export const MAX_SEGMENT_LENGTH = 200;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const WINDOWS_FORBIDDEN = new Set(['<', '>', ':', '"', '|', '?', '*']);

/** Normalises separators (Windows `\` → `/`) and surrounding whitespace. */
export function normalizeEntryPath(input: string): string {
  return input.replaceAll('\\', '/').trim();
}

/** True when the value contains an ASCII control character (including NUL and DEL). */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hasForbiddenCharacter(segment: string, mode: PathMode): boolean {
  if (hasControlCharacter(segment)) return true;
  return mode === 'new' && Array.from(segment).some((char) => WINDOWS_FORBIDDEN.has(char));
}

function validateSegment(segment: string, mode: PathMode): PathErrorReason | null {
  if (segment === '') return 'empty-segment';
  if (segment === '.' || segment === '..') return 'traversal';
  if (segment.startsWith('.')) return 'hidden-segment';
  if (hasForbiddenCharacter(segment, mode)) return 'forbidden-character';
  if (segment.length > MAX_SEGMENT_LENGTH) return 'too-long';
  if (mode === 'existing') return null;
  // Device names are reserved with or without an extension (`nul.txt`).
  if (WINDOWS_RESERVED.test(segment.split('.')[0] ?? '')) return 'reserved-name';
  if (segment.endsWith('.') || segment.endsWith(' ') || segment.startsWith(' ')) {
    return 'trailing-dot-or-space';
  }
  return null;
}

/**
 * Validates a store-relative name. Returns the normalised name (with `/`
 * separators) or the reason it was rejected.
 *
 * - `existing`: safety rules only (no absolute path, no traversal, no hidden
 *   segment, no control character). Used to address entries already in a store
 *   created by `pass` on another OS, which may use characters Windows forbids.
 * - `new` (default): safety rules plus portability rules, so that anything
 *   Sesame creates can be checked out on Windows, macOS and Linux.
 */
export function validateEntryPath(
  input: string,
  mode: PathMode = 'new',
): Result<string, PathErrorReason> {
  const normalized = normalizeEntryPath(input);
  if (normalized === '') return err('empty');
  if (normalized.startsWith('/')) return err('absolute');
  if (mode === 'new' && /^[A-Za-z]:/.test(normalized)) return err('absolute');
  if (normalized.length > MAX_PATH_LENGTH) return err('too-long');
  for (const segment of normalized.split('/')) {
    const reason = validateSegment(segment, mode);
    if (reason !== null) return err(reason);
  }
  return ok(normalized);
}

/** Safety check backing the `EntryPath` brand (already-normalised names only). */
export function isValidEntryPath(input: string): boolean {
  const result = validateEntryPath(input, 'existing');
  return result.ok && result.value === input;
}

/** Last segment of a name, used as login fallback (like browserpass/passff). */
export function lastSegment(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** Parent folder of a name ('' for top-level entries). */
export function parentFolder(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}
