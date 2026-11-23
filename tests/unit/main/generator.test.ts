import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AMBIGUOUS,
  charsetOverrideFromEnv,
  cryptoRandom,
  defaultGeneratorOptions,
  DIGITS,
  EFF_WORDS,
  effectiveClasses,
  expandCharacterSet,
  generatePassword,
  LOWER,
  rejectionSampler,
  SYMBOLS,
  UPPER,
  type RandomSource,
} from '../../../src/main/generator';
import { passwordScore } from '../../../src/main/strength';
import type { CharsOptions } from '../../../src/shared/schemas';
import { unwrap } from '../../helpers/gpgEnv';

/** Deterministic 32-bit PRNG (mulberry32) so that tests never depend on real randomness. */
function seeded(seed: number): RandomSource {
  let state = seed >>> 0;
  return rejectionSampler(() => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  });
}

const base: CharsOptions = defaultGeneratorOptions({});

describe('rejectionSampler', () => {
  it('rejects values from the incomplete bucket instead of folding them', () => {
    // 2^32 % 3 === 1: the single value 2^32 - 1 must be rejected for max = 3.
    const values = [0xffff_ffff, 0xffff_ffff, 7];
    let calls = 0;
    const rng = rejectionSampler(() => values[calls++] ?? 0);
    expect(rng.int(3)).toBe(1);
    expect(calls).toBe(3);
  });

  it('validates its argument', () => {
    expect(() => cryptoRandom.int(0)).toThrow(RangeError);
    expect(() => cryptoRandom.int(1.5)).toThrow(RangeError);
    expect(() => cryptoRandom.int(2 ** 33)).toThrow(RangeError);
    expect(cryptoRandom.int(1)).toBe(0);
    expect(cryptoRandom.int(2 ** 32)).toBeLessThan(2 ** 32);
  });

  it('is unbiased: uniform chi-square over a non power-of-two range', () => {
    const rng = seeded(1234);
    const buckets = 94; // size of the default pool, does not divide 2^32
    const draws = 94_000;
    const counts = new Array<number>(buckets).fill(0);
    for (let i = 0; i < draws; i += 1) {
      const value = rng.int(buckets);
      counts[value] = (counts[value] ?? 0) + 1;
    }
    const expected = draws / buckets;
    const chiSquare = counts.reduce((sum, count) => sum + (count - expected) ** 2 / expected, 0);
    // 93 degrees of freedom: the 99.9th percentile is ~ 143.
    expect(chiSquare).toBeLessThan(143);
    expect(Math.min(...counts)).toBeGreaterThan(0);
  });

  it('the crypto source covers the whole range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) seen.add(cryptoRandom.int(10));
    expect(seen.size).toBe(10);
  });
});

describe('generatePassword (characters)', () => {
  it('uses the pass defaults: 25 characters over the full set', () => {
    const generated = unwrap(generatePassword(base, seeded(1)));
    expect(generated.password).toHaveLength(25);
    expect(generated.entropyBits).toBeCloseTo(25 * Math.log2(94), 6);
    expect(defaultGeneratorOptions({ PASSWORD_STORE_GENERATED_LENGTH: '40' }).length).toBe(40);
    expect(defaultGeneratorOptions({ PASSWORD_STORE_GENERATED_LENGTH: '2' }).length).toBe(8);
    expect(defaultGeneratorOptions({ PASSWORD_STORE_GENERATED_LENGTH: '999' }).length).toBe(128);
    expect(defaultGeneratorOptions({ PASSWORD_STORE_GENERATED_LENGTH: 'abc' }).length).toBe(25);
  });

  it('is deterministic for a given random source', () => {
    const a = unwrap(generatePassword(base, seeded(7))).password;
    const b = unwrap(generatePassword(base, seeded(7))).password;
    const c = unwrap(generatePassword(base, seeded(8))).password;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('fails with a typed error when every character is excluded', () => {
    const none = { ...base, upper: false, lower: false, digits: false, symbols: false };
    expect(generatePassword(none, seeded(1))).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'empty character set' },
    });
    const excluded = { ...none, digits: true, exclude: DIGITS };
    expect(generatePassword(excluded, seeded(1)).ok).toBe(false);
  });

  it('computes the classes left after exclusions', () => {
    expect(effectiveClasses({ ...base, excludeAmbiguous: true })).toEqual([
      'ABCDEFGHJKLMNPQRSTUVWXYZ',
      'abcdefghijkmnopqrstuvwxyz',
      '23456789',
      SYMBOLS.replace('|', ''),
    ]);
    expect(effectiveClasses({ ...base, symbols: false, exclude: 'abc' })).toEqual([
      UPPER,
      LOWER.slice(3),
      DIGITS,
    ]);
  });

  const options = fc.record({
    mode: fc.constant('chars' as const),
    length: fc.integer({ min: 8, max: 128 }),
    upper: fc.boolean(),
    lower: fc.boolean(),
    digits: fc.boolean(),
    symbols: fc.boolean(),
    excludeAmbiguous: fc.boolean(),
    exclude: fc.string({
      unit: fc.constantFrom(...Array.from(UPPER + LOWER + DIGITS + SYMBOLS)),
      maxLength: 30,
    }),
  });

  it('property: length, selected classes and exclusions are always respected', () => {
    fc.assert(
      fc.property(options, fc.integer(), (opts, seed) => {
        const result = generatePassword(opts, seeded(seed));
        const classes = effectiveClasses(opts);
        if (classes.length === 0) {
          expect(result.ok).toBe(false);
          return;
        }
        const { password } = unwrap(result);
        expect(password).toHaveLength(opts.length);
        const allowed = new Set(classes.join(''));
        for (const char of password) expect(allowed.has(char)).toBe(true);
        for (const set of classes) {
          expect(Array.from(password).some((char) => set.includes(char))).toBe(true);
        }
        for (const char of opts.exclude) expect(password.includes(char)).toBe(false);
        if (opts.excludeAmbiguous) {
          for (const char of AMBIGUOUS) expect(password.includes(char)).toBe(false);
        }
        if (!opts.symbols)
          expect(Array.from(password).some((char) => SYMBOLS.includes(char))).toBe(false);
        if (!opts.digits) expect(/\d/.test(password)).toBe(false);
      }),
      { numRuns: 500, seed: 99 },
    );
  });

  it('every position can hold every class (shuffle is not positional)', () => {
    const rng = seeded(5);
    const firstChars = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      firstChars.add(unwrap(generatePassword({ ...base, length: 8 }, rng)).password.charAt(0));
    }
    const has = (set: string): boolean => [...firstChars].some((char) => set.includes(char));
    expect(has(UPPER) && has(LOWER) && has(DIGITS) && has(SYMBOLS)).toBe(true);
  });
});

describe('pass character-set environment variables', () => {
  it('expands tr-style sets', () => {
    expect(expandCharacterSet('[:digit:]')).toBe(DIGITS);
    expect(expandCharacterSet('a-c0-2_')).toBe('abc012_');
    expect(expandCharacterSet('[:alnum:]')).toHaveLength(62);
    expect(expandCharacterSet('[:punct:][:alnum:]')).toHaveLength(94);
    expect(expandCharacterSet('[:unknown:]z-a ')).toBe('[:unkow]z-a');
    expect(expandCharacterSet('')).toBe('');
  });

  it('uses the override sets when defined', () => {
    const override = charsetOverrideFromEnv({
      PASSWORD_STORE_CHARACTER_SET: 'a-f[:digit:]',
      PASSWORD_STORE_CHARACTER_SET_NO_SYMBOLS: 'xyz',
    });
    expect(override).toEqual({ all: 'abcdef0123456789', noSymbols: 'xyz' });
    const withSymbols = unwrap(generatePassword(base, seeded(3), override));
    expect(withSymbols.password).toMatch(/^[a-f0-9]{25}$/);
    const noSymbols = unwrap(generatePassword({ ...base, symbols: false }, seeded(3), override));
    expect(noSymbols.password).toMatch(/^[xyz]{25}$/);
    expect(charsetOverrideFromEnv({ PASSWORD_STORE_CHARACTER_SET: '' })).toEqual({});
    expect(charsetOverrideFromEnv({})).toEqual({});
  });
});

describe('passphrase and PIN modes', () => {
  it('embeds the EFF large wordlist', () => {
    expect(EFF_WORDS).toHaveLength(7776);
    expect(new Set(EFF_WORDS).size).toBe(7776);
    expect(EFF_WORDS[0]).toBe('abacus');
    expect(EFF_WORDS.at(-1)).toBe('zoom');
  });

  it('property: passphrases have the requested shape', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: 12 }),
        fc.constantFrom('-', ' ', '.', '', '_#'),
        fc.boolean(),
        fc.boolean(),
        fc.integer(),
        (words, separator, capitalize, addDigit, seed) => {
          const { password, entropyBits } = unwrap(
            generatePassword(
              { mode: 'passphrase', words, separator, capitalize, addDigit },
              seeded(seed),
            ),
          );
          const digits = password.replace(/\D/g, '');
          expect(digits).toHaveLength(addDigit ? 1 : 0);
          const expectedBits = words * Math.log2(7776) + (addDigit ? Math.log2(words * 10) : 0);
          expect(entropyBits).toBeCloseTo(expectedBits, 6);
          if (separator === '-' || separator === ' ' || separator === '.' || separator === '_#') {
            const parts = password.replace(/\d/g, '').split(separator);
            expect(parts).toHaveLength(words);
            for (const part of parts) {
              expect(EFF_WORDS.includes(part.toLowerCase())).toBe(true);
              expect(/^[A-Z]/.test(part)).toBe(capitalize);
            }
          }
        },
      ),
      { numRuns: 200, seed: 7 },
    );
  });

  it('property: PINs are digits only', () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 12 }), fc.integer(), (length, seed) => {
        const { password, entropyBits } = unwrap(
          generatePassword({ mode: 'pin', length }, seeded(seed)),
        );
        expect(password).toMatch(new RegExp(`^\\d{${String(length)}}$`));
        expect(entropyBits).toBeCloseTo(length * Math.log2(10), 6);
      }),
      { numRuns: 100, seed: 3 },
    );
  });
});

describe('passwordScore (zxcvbn)', () => {
  it('ranks weak and strong passwords', () => {
    expect(passwordScore('password')).toBe(0);
    expect(passwordScore(unwrap(generatePassword(base, seeded(11))).password)).toBe(4);
    expect(passwordScore('x'.repeat(500))).toBeLessThanOrEqual(4);
  });
});
