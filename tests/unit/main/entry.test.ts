import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEntry,
  isValidOtpUri,
  lineOf,
  loginFor,
  parseEntry,
  replaceFirstLine,
  safeHttpUrl,
  setOtpUri,
  splitLines,
  totpCode,
} from '../../../src/main/store/entry';

// RFC 6238 reference secret ("12345678901234567890").
const OTP_URI =
  'otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example';

describe('parseEntry', () => {
  it('reads the password, fields, notes and otp line', () => {
    const entry = parseEntry(
      [
        'hunter2',
        'login: alice',
        'URL: https://example.org/login',
        'pin : 1234',
        OTP_URI,
        'free text',
        'https://not-a-field.example',
        '',
        'second paragraph',
      ].join('\n'),
    );
    expect(entry.password).toBe('hunter2');
    expect(entry.fields).toEqual([
      { key: 'login', value: 'alice', line: 2 },
      { key: 'URL', value: 'https://example.org/login', line: 3 },
      { key: 'pin', value: '1234', line: 4 },
    ]);
    expect(entry.login).toBe('alice');
    expect(entry.url).toBe('https://example.org/login');
    expect(entry.otpUri).toBe(OTP_URI);
    expect(entry.notes).toBe('free text\nhttps://not-a-field.example\n\nsecond paragraph');
  });

  it('handles CRLF, a trailing newline and an empty entry', () => {
    expect(parseEntry('pw\r\nuser: bob\r\n').fields).toEqual([
      { key: 'user', value: 'bob', line: 2 },
    ]);
    expect(parseEntry('pw\n').notes).toBe('');
    expect(parseEntry('').password).toBe('');
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });

  it('prefers login over user, username and email, ignoring empty values', () => {
    expect(parseEntry('pw\nemail: e@x.org\nusername: u\nuser: v').login).toBe('v');
    expect(parseEntry('pw\nlogin:\nemail: e@x.org').login).toBe('e@x.org');
    expect(parseEntry('pw').login).toBeNull();
    expect(parseEntry('pw\nwebsite: example.org').url).toBe('example.org');
  });

  it('accepts the otp uri as a field value and keeps the first one', () => {
    const entry = parseEntry(`pw\notpauth: ${OTP_URI}\notpauth://totp/other?secret=AAAA`);
    expect(entry.otpUri).toBe(OTP_URI);
    expect(entry.fields).toEqual([]);
  });

  it('falls back to the last path segment for the login', () => {
    expect(loginFor(parseEntry('pw'), 'web/github.com/alice')).toBe('alice');
    expect(loginFor(parseEntry('pw\nlogin: bob'), 'web/github.com/alice')).toBe('bob');
  });
});

describe('entry editing helpers', () => {
  it('returns a given line like pass show --clip=N', () => {
    expect(lineOf('a\nb\nc\n', 2)).toBe('b');
    expect(lineOf('a\nb\n', 3)).toBeNull();
  });

  it('replaces only the first line', () => {
    expect(replaceFirstLine('old\nlogin: a\nnote\n', 'new')).toBe('new\nlogin: a\nnote\n');
    expect(replaceFirstLine('old', 'new')).toBe('new\n');
  });

  it('builds an entry from a form', () => {
    expect(buildEntry({ password: 'pw' })).toBe('pw\n');
    expect(buildEntry({ password: 'pw', login: '', url: '', notes: '  ' })).toBe('pw\n');
    expect(
      buildEntry({ password: 'pw', login: 'a', url: 'https://x.org', notes: ' n1\nn2 ' }),
    ).toBe('pw\nlogin: a\nurl: https://x.org\nn1\nn2\n');
  });

  it('appends or replaces the otpauth line', () => {
    expect(setOtpUri('pw\nlogin: a\n', OTP_URI)).toBe(`pw\nlogin: a\n${OTP_URI}\n`);
    expect(setOtpUri(`pw\notpauth://totp/old?secret=AAAA\nnote`, OTP_URI)).toBe(
      `pw\n${OTP_URI}\nnote\n`,
    );
    // A password that happens to look like a URI is never touched.
    expect(setOtpUri('otpauth://weird', OTP_URI)).toBe(`otpauth://weird\n${OTP_URI}\n`);
  });

  it('only lets http(s) URLs reach the browser', () => {
    expect(safeHttpUrl('https://example.org/a?b=1')).toBe('https://example.org/a?b=1');
    expect(safeHttpUrl('example.org')).toBe('https://example.org/');
    expect(safeHttpUrl('http://example.org')).toBe('http://example.org/');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
    expect(safeHttpUrl('ms-msdt:/id')).toBeNull();
    expect(safeHttpUrl('https://')).toBeNull();
  });
});

describe('totp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches the RFC 6238 test vectors with a simulated clock', () => {
    vi.setSystemTime(59_000);
    expect(totpCode(OTP_URI, Date.now())).toEqual({
      ok: true,
      value: { code: '287082', period: 30, remaining: 1 },
    });
    vi.setSystemTime(1_111_111_109_000);
    expect(totpCode(OTP_URI, Date.now())).toEqual({
      ok: true,
      value: { code: '081804', period: 30, remaining: 1 },
    });
    vi.setSystemTime(1_111_111_111_000);
    const next = totpCode(OTP_URI, Date.now());
    expect(next.ok && next.value.code).toBe('050471');
    expect(next.ok && next.value.remaining).toBe(29);
  });

  it('honours digits and period parameters', () => {
    expect(totpCode(`${OTP_URI}&digits=8`, 59_000)).toEqual({
      ok: true,
      value: { code: '94287082', period: 30, remaining: 1 },
    });
    const slow = totpCode(`${OTP_URI}&period=60`, 59_000);
    expect(slow.ok && slow.value.period).toBe(60);
    expect(slow.ok && slow.value.remaining).toBe(1);
  });

  it('rejects invalid and non-TOTP URIs', () => {
    expect(totpCode('otpauth://totp/x', 0)).toEqual({ ok: false, error: { kind: 'otp-invalid' } });
    expect(totpCode('otpauth://hotp/x?secret=GEZDGNBV&counter=1', 0).ok).toBe(false);
    expect(isValidOtpUri(` ${OTP_URI} `)).toBe(true);
    expect(isValidOtpUri('https://example.org')).toBe(false);
  });
});
