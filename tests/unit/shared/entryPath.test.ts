import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isValidEntryPath,
  lastSegment,
  MAX_PATH_LENGTH,
  MAX_SEGMENT_LENGTH,
  normalizeEntryPath,
  parentFolder,
  validateEntryPath,
} from '../../../src/shared/entryPath';
import {
  asFolderPath,
  EntryPathSchema,
  FolderPathSchema,
  GpgKeyIdSchema,
  isValidGpgKeyId,
} from '../../../src/shared/types';
import {
  checkCreatable,
  entryFile,
  entryNameFromRelative,
  parseEntryPath,
  resolveInStore,
} from '../../../src/main/store/paths';

const reasonOf = (input: string, mode: 'new' | 'existing' = 'new'): string | null => {
  const result = validateEntryPath(input, mode);
  return result.ok ? null : result.error;
};

describe('validateEntryPath', () => {
  it('accepts nested names and normalises separators', () => {
    expect(validateEntryPath('web/github.com/me')).toEqual({
      ok: true,
      value: 'web/github.com/me',
    });
    expect(validateEntryPath('  web\\github.com\\me ')).toEqual({
      ok: true,
      value: 'web/github.com/me',
    });
    expect(normalizeEntryPath('a\\b')).toBe('a/b');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['/etc/passwd', 'absolute'],
    ['\\\\server\\share', 'absolute'],
    ['C:\\Users\\me', 'absolute'],
    ['c:foo', 'absolute'],
    ['..', 'traversal'],
    ['../outside', 'traversal'],
    ['a/../../b', 'traversal'],
    ['a/./b', 'traversal'],
    ['a\\..\\..\\b', 'traversal'],
    ['a//b', 'empty-segment'],
    ['a/', 'empty-segment'],
    ['.git/config', 'hidden-segment'],
    ['a/.gpg-id', 'hidden-segment'],
    ['...', 'hidden-segment'],
    ['a\u0000b', 'forbidden-character'],
    ['a\nb', 'forbidden-character'],
    ['a\u007fb', 'forbidden-character'],
    ['a<b', 'forbidden-character'],
    ['a|b', 'forbidden-character'],
    ['what?', 'forbidden-character'],
    ['a*', 'forbidden-character'],
    ['say"hi"', 'forbidden-character'],
    ['host:8080', 'forbidden-character'],
    ['CON', 'reserved-name'],
    ['web/nul.txt', 'reserved-name'],
    ['com1', 'reserved-name'],
    ['LPT9', 'reserved-name'],
    ['trailing.', 'trailing-dot-or-space'],
    ['a /b', 'trailing-dot-or-space'],
    ['a/ b', 'trailing-dot-or-space'],
    ['x'.repeat(MAX_SEGMENT_LENGTH + 1), 'too-long'],
    [Array.from({ length: 60 }, () => 'abcdefghij').join('/'), 'too-long'],
  ])('rejects %j as %s', (input, reason) => {
    expect(reasonOf(input)).toBe(reason);
  });

  it('accepts option-looking names (they are never used as options)', () => {
    expect(reasonOf('--output')).toBeNull();
    expect(reasonOf('-rf')).toBeNull();
  });

  it('is lenient on portability for existing entries, strict on safety', () => {
    expect(reasonOf('host:8080', 'existing')).toBeNull();
    expect(reasonOf('what?', 'existing')).toBeNull();
    expect(reasonOf('CON', 'existing')).toBeNull();
    expect(reasonOf('trailing.', 'existing')).toBeNull();
    expect(reasonOf('c:foo', 'existing')).toBeNull();
    expect(reasonOf('../x', 'existing')).toBe('traversal');
    expect(reasonOf('/x', 'existing')).toBe('absolute');
    expect(reasonOf('.git/x', 'existing')).toBe('hidden-segment');
    expect(reasonOf('a\u0001', 'existing')).toBe('forbidden-character');
    expect(reasonOf('x'.repeat(MAX_PATH_LENGTH + 1), 'existing')).toBe('too-long');
  });

  it('isValidEntryPath only accepts already-normalised names', () => {
    expect(isValidEntryPath('a/b')).toBe(true);
    expect(isValidEntryPath('a\\b')).toBe(false);
    expect(isValidEntryPath(' a')).toBe(false);
    expect(isValidEntryPath('../a')).toBe(false);
  });

  it('exposes path helpers', () => {
    expect(lastSegment('web/github.com/me')).toBe('me');
    expect(lastSegment('me')).toBe('me');
    expect(parentFolder('web/github.com/me')).toBe('web/github.com');
    expect(parentFolder('me')).toBe('');
  });
});

describe('branded schemas', () => {
  it('brands only valid values', () => {
    expect(EntryPathSchema.safeParse('a/b').success).toBe(true);
    expect(EntryPathSchema.safeParse('../b').success).toBe(false);
    expect(FolderPathSchema.safeParse('').success).toBe(true);
    expect(FolderPathSchema.safeParse('a/b').success).toBe(true);
    expect(FolderPathSchema.safeParse('/a').success).toBe(false);
  });

  it('rejects option-looking or malformed gpg recipients', () => {
    expect(isValidGpgKeyId('0123456789ABCDEF')).toBe(true);
    expect(isValidGpgKeyId('Alice <alice@example.org>')).toBe(true);
    expect(isValidGpgKeyId('--no-default-keyring')).toBe(false);
    expect(isValidGpgKeyId('-r')).toBe(false);
    expect(isValidGpgKeyId('')).toBe(false);
    expect(isValidGpgKeyId(' padded ')).toBe(false);
    expect(isValidGpgKeyId('a\nb')).toBe(false);
    expect(isValidGpgKeyId('a\u007fb')).toBe(false);
    expect(isValidGpgKeyId('x'.repeat(257))).toBe(false);
    expect(GpgKeyIdSchema.safeParse('--homedir=/tmp').success).toBe(false);
  });
});

describe('paths (main)', () => {
  const store = path.resolve('/tmp/store');

  it('parses, brands and resolves names inside the store', () => {
    const parsed = parseEntryPath(' web\\site ');
    expect(parsed).toEqual({ ok: true, value: 'web/site' });
    if (!parsed.ok) return;
    expect(entryFile(store, parsed.value)).toEqual({
      ok: true,
      value: path.join(store, 'web', 'site.gpg'),
    });
    expect(resolveInStore(store, parsed.value)).toEqual({
      ok: true,
      value: path.join(store, 'web', 'site'),
    });
    expect(checkCreatable(parsed.value).ok).toBe(true);
  });

  it('reports typed errors', () => {
    expect(parseEntryPath('../x')).toEqual({
      ok: false,
      error: { kind: 'invalid-path', reason: 'traversal' },
    });
    const colon = parseEntryPath('ab:c', 'existing');
    expect(colon.ok).toBe(true);
    if (colon.ok) {
      expect(checkCreatable(colon.value)).toEqual({
        ok: false,
        error: { kind: 'invalid-path', reason: 'forbidden-character' },
      });
    }
  });

  it('resolves the root folder', () => {
    expect(resolveInStore(store, asFolderPath(''))).toEqual({ ok: true, value: store });
    expect(resolveInStore(store, asFolderPath(''), '.gpg-id')).toEqual({
      ok: true,
      value: path.join(store, '.gpg-id'),
    });
  });

  it('refuses drive-relative names on Windows even if lexically valid', () => {
    const sneaky = parseEntryPath('c:evil', 'existing');
    expect(sneaky.ok).toBe(true);
    if (!sneaky.ok) return;
    expect(resolveInStore('D:\\store', sneaky.value, '.gpg', path.win32)).toEqual({
      ok: false,
      error: { kind: 'invalid-path', reason: 'absolute' },
    });
    // Trailing dots are stripped by Windows: `x....` would alias another name.
    const dots = parseEntryPath('ab....', 'existing');
    expect(dots.ok && resolveInStore('D:\\store', dots.value, '', path.win32).ok).toBe(false);
    expect(dots.ok && resolveInStore('/store', dots.value, '', path.posix).ok).toBe(true);
  });

  it('maps files on disk back to entry names', () => {
    expect(entryNameFromRelative(path.join('web', 'site.gpg'))).toBe('web/site');
    expect(entryNameFromRelative('notes.txt')).toBeNull();
    expect(entryNameFromRelative(path.join('.git', 'x.gpg'))).toBeNull();
    expect(entryNameFromRelative(' padded.gpg')).toBeNull();
  });
});

describe('path traversal properties', () => {
  const nasty = fc.constantFrom(
    '..',
    '.',
    '',
    '/',
    '\\',
    'a',
    'C:',
    'c:',
    '..\\',
    '../',
    '~',
    '%2e%2e',
    'con',
    '.git',
    ' ',
    '\u0000',
    '\u202e',
    '．．',
    'x.gpg',
    '-',
    '--',
  );
  const candidate = fc.oneof(
    fc.string({ unit: 'binary', maxLength: 40 }),
    fc.string({ maxLength: 40 }),
    fc.array(nasty, { maxLength: 8 }).map((parts) => parts.join('/')),
    fc.array(nasty, { maxLength: 8 }).map((parts) => parts.join('')),
    fc.array(nasty, { maxLength: 8 }).map((parts) => parts.join('\\')),
  );

  const isInside = (api: typeof path.posix, root: string, target: string): boolean => {
    const relative = api.relative(root, target);
    return relative !== '' && !relative.startsWith('..') && !api.isAbsolute(relative);
  };

  it.each([
    ['posix', path.posix, '/home/user/.password-store'],
    ['win32', path.win32, 'C:\\Users\\me\\.password-store'],
  ] as const)('no string can escape the store (%s)', (_name, api, root) => {
    fc.assert(
      fc.property(candidate, fc.constantFrom('existing', 'new'), (input, mode) => {
        const parsed = parseEntryPath(input, mode);
        if (!parsed.ok) return;
        for (const suffix of ['', '.gpg']) {
          const resolved = resolveInStore(root, parsed.value, suffix, api);
          if (resolved.ok) expect(isInside(api, root, resolved.value)).toBe(true);
        }
      }),
      { numRuns: 3000, seed: 20261123 },
    );
  });

  it('never accepts a name containing a traversal or hidden segment', () => {
    fc.assert(
      fc.property(candidate, (input) => {
        const parsed = parseEntryPath(input, 'existing');
        if (!parsed.ok) return;
        const segments = parsed.value.split('/');
        expect(segments.every((segment) => segment !== '' && !segment.startsWith('.'))).toBe(true);
        expect(parsed.value.includes('\\')).toBe(false);
      }),
      { numRuns: 3000, seed: 42 },
    );
  });
});
