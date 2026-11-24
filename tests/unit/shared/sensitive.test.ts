import { describe, expect, it } from 'vitest';
import { fieldKeyOf, isSensitiveKey, isSensitiveLine } from '../../../src/shared/sensitive';

describe('sensitive field keys', () => {
  it.each([
    'password',
    'Password',
    'old password',
    'wifi_password',
    'passwd',
    'pass',
    'pwd',
    'passphrase',
    'PIN',
    'card pin',
    'PUK',
    'secret',
    'client-secret',
    'token',
    'accessToken',
    'api key',
    'apiKey',
    'API_KEY',
    'private key',
    'privateKey',
    'mot de passe',
    'Mot-de-passe',
    'mdp',
    'code secret',
    'CVV',
    'cvc2',
    'recovery codes',
    'backup codes',
    'seed',
    'mnemonic',
    'otp',
    'credentials',
  ])('masks %j', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'login',
    'user',
    'username',
    'email',
    'url',
    'spinner',
    'passport',
    'compass',
    'tokenizer',
    'note',
    'rotation',
    'change-url',
    'keyboard',
    'postal code',
  ])('does not mask %j', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });

  it('reads keys of entry lines', () => {
    expect(fieldKeyOf('Password: hunter2')).toBe('Password');
    expect(fieldKeyOf('mot de passe : x')).toBe('mot de passe');
    expect(fieldKeyOf('Clé privée: x')).toBe('Clé privée');
    expect(fieldKeyOf('free text')).toBeNull();
    expect(isSensitiveLine('pin: 1234')).toBe(true);
    expect(isSensitiveLine('login: alice')).toBe(false);
    expect(isSensitiveLine('my password is hunter2')).toBe(false);
  });
});
