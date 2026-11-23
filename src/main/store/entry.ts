import { TOTP, URI } from 'otpauth';
import type { AppError } from '../../shared/errors';
import { lastSegment } from '../../shared/entryPath';
import { err, ok, type Result } from '../../shared/result';
import type { Field, OtpCode } from '../../shared/schemas';

/** Parsing of the `pass` entry format (first line = password, then free text). */
export interface ParsedEntry {
  readonly password: string;
  readonly fields: readonly Field[];
  readonly notes: string;
  readonly login: string | null;
  readonly url: string | null;
  readonly otpUri: string | null;
}

const FIELD_PATTERN = /^([A-Za-z0-9][A-Za-z0-9 _.-]{0,39}):\s*(.*)$/;
const LOGIN_KEYS = ['login', 'user', 'username', 'email'];
const URL_KEYS = ['url', 'website', 'link'];
const OTP_PREFIX = 'otpauth://';

export function splitLines(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  // A trailing newline is a line terminator, not an extra empty line.
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines;
}

function findByKeys(fields: readonly Field[], keys: readonly string[]): string | null {
  for (const key of keys) {
    const match = fields.find((field) => field.key.toLowerCase() === key && field.value !== '');
    if (match !== undefined) return match.value;
  }
  return null;
}

export function parseEntry(raw: string): ParsedEntry {
  const lines = splitLines(raw);
  const fields: Field[] = [];
  const notes: string[] = [];
  let otpUri: string | null = null;
  lines.slice(1).forEach((line, index) => {
    const lineNumber = index + 2;
    const trimmed = line.trim();
    if (trimmed.startsWith(OTP_PREFIX)) {
      otpUri ??= trimmed;
      return;
    }
    const match = FIELD_PATTERN.exec(line);
    const key = match?.[1];
    const value = match?.[2];
    if (key !== undefined && value !== undefined && !value.startsWith('//')) {
      if (value.startsWith(OTP_PREFIX)) otpUri ??= value.trim();
      else fields.push({ key: key.trim(), value: value.trim(), line: lineNumber });
      return;
    }
    notes.push(line);
  });
  return {
    password: lines[0] ?? '',
    fields,
    notes: notes.join('\n').trim(),
    login: findByKeys(fields, LOGIN_KEYS),
    url: findByKeys(fields, URL_KEYS),
    otpUri,
  };
}

/** Login to copy: explicit field, else the last path segment (browserpass convention). */
export function loginFor(entry: ParsedEntry, path: string): string {
  return entry.login ?? lastSegment(path);
}

/** `pass show --clip=N`: 1-based line of the decrypted entry. */
export function lineOf(raw: string, line: number): string | null {
  return splitLines(raw)[line - 1] ?? null;
}

/** `pass generate --in-place`: replace only the first line. */
export function replaceFirstLine(raw: string, password: string): string {
  const index = raw.indexOf('\n');
  return index === -1 ? `${password}\n` : password + raw.slice(index);
}

export interface EntryDraft {
  readonly password: string;
  readonly login?: string;
  readonly url?: string;
  readonly notes?: string;
}

export function buildEntry(draft: EntryDraft): string {
  const lines = [draft.password];
  if (draft.login !== undefined && draft.login !== '') lines.push(`login: ${draft.login}`);
  if (draft.url !== undefined && draft.url !== '') lines.push(`url: ${draft.url}`);
  if (draft.notes !== undefined && draft.notes.trim() !== '') lines.push(draft.notes.trim());
  return `${lines.join('\n')}\n`;
}

/** Adds or replaces the `otpauth://` line (pass-otp `insert`/`append`). */
export function setOtpUri(raw: string, uri: string): string {
  const lines = splitLines(raw);
  const index = lines.findIndex(
    (line, position) => position > 0 && line.trim().startsWith(OTP_PREFIX),
  );
  if (index === -1) lines.push(uri);
  else lines[index] = uri;
  return `${lines.join('\n')}\n`;
}

function parseTotp(uri: string): TOTP | null {
  try {
    const parsed = URI.parse(uri);
    return parsed instanceof TOTP ? parsed : null;
  } catch {
    return null;
  }
}

export function isValidOtpUri(uri: string): boolean {
  return parseTotp(uri.trim()) !== null;
}

/** Current TOTP code for an `otpauth://totp/...` URI at the given time. */
export function totpCode(uri: string, nowMs: number): Result<OtpCode, AppError> {
  const totp = parseTotp(uri);
  if (totp === null) return err({ kind: 'otp-invalid' });
  const seconds = Math.floor(nowMs / 1000);
  return ok({
    code: totp.generate({ timestamp: nowMs }),
    period: totp.period,
    remaining: totp.period - (seconds % totp.period),
  });
}

/** Only http(s) URLs may be handed to the system browser. */
export function safeHttpUrl(value: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}
