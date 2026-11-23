import { webcrypto } from 'node:crypto';
import type { AppError } from '../shared/errors';
import { err, ok, type Result } from '../shared/result';
import type {
  CharsOptions,
  GeneratorOptions,
  PassphraseOptions,
  PinOptions,
} from '../shared/schemas';
import { asPlainSecret, type PlainSecret } from '../shared/types';
import wordlist from './eff-wordlist.json';

/** Source of uniformly distributed integers in `[0, maxExclusive)`. */
export interface RandomSource {
  int(maxExclusive: number): number;
}

const UINT32_RANGE = 0x1_0000_0000;

/**
 * Builds an unbiased integer source from raw 32-bit values using rejection
 * sampling: values falling in the incomplete last bucket are discarded instead
 * of being folded with a modulo (which would favour small results).
 */
export function rejectionSampler(next32: () => number): RandomSource {
  return {
    int(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_RANGE) {
        throw new RangeError('maxExclusive must be an integer in [1, 2^32]');
      }
      const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
      for (;;) {
        const value = next32();
        if (value < limit) return value % maxExclusive;
      }
    },
  };
}

const buffer = new Uint32Array(1);
/** Cryptographically secure default source (`crypto.getRandomValues`). */
export const cryptoRandom: RandomSource = rejectionSampler(() => {
  webcrypto.getRandomValues(buffer);
  return buffer[0] ?? 0;
});

export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const DIGITS = '0123456789';
export const SYMBOLS = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
export const AMBIGUOUS = '0O1lI|';
export const EFF_WORDS: readonly string[] = wordlist;

const POSIX_CLASSES: Readonly<Record<string, string>> = {
  alnum: UPPER + LOWER + DIGITS,
  alpha: UPPER + LOWER,
  digit: DIGITS,
  upper: UPPER,
  lower: LOWER,
  punct: SYMBOLS,
  graph: UPPER + LOWER + DIGITS + SYMBOLS,
  xdigit: '0123456789abcdefABCDEF',
};

/**
 * Expands a `tr`-style set as used by `PASSWORD_STORE_CHARACTER_SET`
 * (`[:punct:][:alnum:]`, `a-z0-9`, literal characters).
 */
export function expandCharacterSet(spec: string): string {
  const chars = new Set<string>();
  let rest = spec;
  while (rest !== '') {
    const posix = /^\[:([a-z]+):\]/.exec(rest);
    const range = /^([A-Za-z0-9])-([A-Za-z0-9])/.exec(rest);
    const posixSet = posix?.[1] === undefined ? undefined : POSIX_CLASSES[posix[1]];
    if (posix !== null && posixSet !== undefined) {
      for (const char of posixSet) chars.add(char);
      rest = rest.slice(posix[0].length);
    } else if (range?.[1] !== undefined && range[2] !== undefined && range[1] <= range[2]) {
      for (let code = range[1].charCodeAt(0); code <= range[2].charCodeAt(0); code += 1) {
        chars.add(String.fromCharCode(code));
      }
      rest = rest.slice(range[0].length);
    } else {
      const [first = ''] = rest;
      if (first.trim() !== '') chars.add(first);
      rest = rest.slice(first.length);
    }
  }
  return [...chars].join('');
}

/** Character sets coming from the `pass` environment variables. */
export interface CharsetOverride {
  readonly all?: string;
  readonly noSymbols?: string;
}

export function charsetOverrideFromEnv(env: NodeJS.ProcessEnv): CharsetOverride {
  const all = env.PASSWORD_STORE_CHARACTER_SET;
  const noSymbols = env.PASSWORD_STORE_CHARACTER_SET_NO_SYMBOLS;
  return {
    ...(all === undefined || all === '' ? {} : { all: expandCharacterSet(all) }),
    ...(noSymbols === undefined || noSymbols === ''
      ? {}
      : { noSymbols: expandCharacterSet(noSymbols) }),
  };
}

export interface Generated {
  readonly password: PlainSecret;
  /** Entropy of the generation process, in bits. */
  readonly entropyBits: number;
}

const pick = (pool: string | readonly string[], rng: RandomSource): string =>
  pool[rng.int(pool.length)] ?? '';

function shuffle(items: string[], rng: RandomSource): string[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = rng.int(index + 1);
    const current = items[index] ?? '';
    items[index] = items[other] ?? '';
    items[other] = current;
  }
  return items;
}

/** The character classes in effect once exclusions are applied. */
export function effectiveClasses(options: CharsOptions, override: CharsetOverride = {}): string[] {
  const excluded = new Set(options.exclude + (options.excludeAmbiguous ? AMBIGUOUS : ''));
  const filter = (set: string): string =>
    Array.from(set)
      .filter((char) => !excluded.has(char))
      .join('');
  const custom = options.symbols ? override.all : override.noSymbols;
  const classes =
    custom === undefined
      ? [
          options.upper ? UPPER : '',
          options.lower ? LOWER : '',
          options.digits ? DIGITS : '',
          options.symbols ? SYMBOLS : '',
        ]
      : [custom];
  return classes.map(filter).filter((set) => set !== '');
}

function generateChars(
  options: CharsOptions,
  rng: RandomSource,
  override: CharsetOverride,
): Result<Generated, AppError> {
  const classes = effectiveClasses(options, override);
  if (classes.length === 0 || classes.length > options.length) {
    return err({ kind: 'invalid-argument', message: 'empty character set' });
  }
  const pool = [...new Set(classes.join(''))].join('');
  // One character of each selected class is guaranteed, the rest is drawn
  // from the whole pool, then everything is shuffled.
  const chars = classes.map((set) => pick(set, rng));
  while (chars.length < options.length) chars.push(pick(pool, rng));
  return ok({
    password: asPlainSecret(shuffle(chars, rng).join('')),
    entropyBits: options.length * Math.log2(pool.length),
  });
}

function generatePassphrase(options: PassphraseOptions, rng: RandomSource): Generated {
  const words = Array.from({ length: options.words }, () => pick(EFF_WORDS, rng)).map((word) =>
    options.capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word,
  );
  let entropyBits = options.words * Math.log2(EFF_WORDS.length);
  if (options.addDigit) {
    const position = rng.int(words.length);
    words[position] = (words[position] ?? '') + pick(DIGITS, rng);
    entropyBits += Math.log2(words.length * DIGITS.length);
  }
  return { password: asPlainSecret(words.join(options.separator)), entropyBits };
}

function generatePin(options: PinOptions, rng: RandomSource): Generated {
  const digits = Array.from({ length: options.length }, () => pick(DIGITS, rng));
  return {
    password: asPlainSecret(digits.join('')),
    entropyBits: options.length * Math.log2(DIGITS.length),
  };
}

export function generatePassword(
  options: GeneratorOptions,
  rng: RandomSource = cryptoRandom,
  override: CharsetOverride = {},
): Result<Generated, AppError> {
  switch (options.mode) {
    case 'chars':
      return generateChars(options, rng, override);
    case 'passphrase':
      return ok(generatePassphrase(options, rng));
    case 'pin':
      return ok(generatePin(options, rng));
  }
}

/** Default options, honouring `PASSWORD_STORE_GENERATED_LENGTH` (25 like pass). */
export function defaultGeneratorOptions(env: NodeJS.ProcessEnv): CharsOptions {
  const fromEnv = Number.parseInt(env.PASSWORD_STORE_GENERATED_LENGTH ?? '', 10);
  const length = Number.isNaN(fromEnv) ? 25 : Math.min(128, Math.max(8, fromEnv));
  return {
    mode: 'chars',
    length,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: false,
    exclude: '',
  };
}
