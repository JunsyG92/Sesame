/**
 * Field keys whose value is a secret and must be masked like the password
 * line (`password:`, `pin:`, `token:`, `mot de passe:`…). Matching is done on
 * whole words of the key, so `pin` matches `PIN` or `card pin` but not `spinner`.
 */
const SENSITIVE_WORDS = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  'passphrase',
  'passcode',
  'mdp',
  'pin',
  'puk',
  'secret',
  'token',
  'apikey',
  'cvv',
  'cvc',
  'csc',
  'cvv2',
  'cvc2',
  'otp',
  'totp',
  'seed',
  'mnemonic',
  'recovery',
  'backup',
  'privatekey',
  'credential',
  'credentials',
]);

/** Pairs written as two words (`api key`, `mot de passe`, `private_key`…). */
const SENSITIVE_PAIRS = [
  'api key',
  'mot de passe',
  'private key',
  'secret key',
  'access key',
  'code secret',
];

function words(key: string): string[] {
  return key
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

export function isSensitiveKey(key: string): boolean {
  const parts = words(key);
  if (parts.some((word) => SENSITIVE_WORDS.has(word))) return true;
  const joined = parts.join(' ');
  return (
    SENSITIVE_PAIRS.some((pair) => ` ${joined} `.includes(` ${pair} `)) ||
    SENSITIVE_WORDS.has(parts.join(''))
  );
}

/** Key of a `key: value` line, or null (same shape as the entry parser). */
export function fieldKeyOf(line: string): string | null {
  const match = /^([A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ _.-]{0,39}):\s*(.*)$/.exec(line);
  return match?.[1]?.trim() ?? null;
}

/** True when a line of an entry is (or contains) a secret: a sensitive `key: value` line. */
export function isSensitiveLine(line: string): boolean {
  const key = fieldKeyOf(line);
  return key !== null && isSensitiveKey(key);
}
