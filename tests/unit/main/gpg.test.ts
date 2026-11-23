import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Runner } from '../../../src/main/exec';
import { runProcess } from '../../../src/main/exec';
import {
  findGpg,
  Gpg,
  gpgError,
  isExecutable,
  parseGpgOpts,
  parseKeyListing,
} from '../../../src/main/store/gpg';
import { asPlainSecret } from '../../../src/shared/types';
import { createSandbox, keyId, unwrap, type Sandbox } from '../../helpers/gpgEnv';

describe('findGpg', () => {
  const only =
    (...existing: string[]) =>
    (file: string): Promise<boolean> =>
      Promise.resolve(existing.includes(file));

  it('prefers the custom path, then PATH, then standard locations', async () => {
    const env = { PATH: '/opt/a:/opt/b' };
    expect(await findGpg('linux', env, '/custom/gpg', only('/custom/gpg', '/opt/a/gpg'))).toBe(
      '/custom/gpg',
    );
    expect(await findGpg('linux', env, '/custom/gpg', only('/opt/b/gpg2', '/usr/bin/gpg'))).toBe(
      '/opt/b/gpg2',
    );
    expect(await findGpg('linux', env, null, only('/usr/bin/gpg'))).toBe('/usr/bin/gpg');
    expect(await findGpg('linux', {}, null, only())).toBeNull();
  });

  it('knows Homebrew and GPG Suite locations on macOS', async () => {
    expect(await findGpg('darwin', { PATH: '' }, null, only('/opt/homebrew/bin/gpg'))).toBe(
      '/opt/homebrew/bin/gpg',
    );
    expect(await findGpg('darwin', {}, null, only('/usr/local/MacGPG2/bin/gpg2'))).toBe(
      '/usr/local/MacGPG2/bin/gpg2',
    );
  });

  it('knows Gpg4win locations on Windows', async () => {
    const gpg4win = 'C:\\Program Files (x86)\\GnuPG\\bin\\gpg.exe';
    expect(
      await findGpg('win32', { Path: 'C:\\tools;C:\\bin' }, null, only('C:\\bin\\gpg.exe')),
    ).toBe('C:\\bin\\gpg.exe');
    expect(await findGpg('win32', {}, null, only(gpg4win))).toBe(gpg4win);
    expect(
      await findGpg(
        'win32',
        { ProgramFiles: 'D:\\Apps' },
        null,
        only('D:\\Apps\\GnuPG\\bin\\gpg.exe'),
      ),
    ).toBe('D:\\Apps\\GnuPG\\bin\\gpg.exe');
  });

  it('probes real files', async () => {
    expect(await isExecutable(process.execPath)).toBe(true);
    expect(await isExecutable(path.join(process.execPath, 'missing'))).toBe(false);
  });
});

describe('gpg output parsing', () => {
  it('splits PASSWORD_STORE_GPG_OPTS', () => {
    expect(parseGpgOpts({ PASSWORD_STORE_GPG_OPTS: ' --armor   --no-tty ' })).toEqual([
      '--armor',
      '--no-tty',
    ]);
    expect(parseGpgOpts({})).toEqual([]);
  });

  it('maps status lines to typed errors', () => {
    const run = (stderr: string): ReturnType<typeof gpgError> =>
      gpgError({ code: 2, stdout: '', stderr });
    expect(run('[GNUPG:] NO_SECKEY 0123\ngpg: decryption failed: No secret key')).toEqual({
      kind: 'gpg-no-secret-key',
    });
    expect(run('[GNUPG:] ERROR pkdecrypt_failed 83886179\ngpg: cancelled')).toEqual({
      kind: 'gpg-cancelled',
    });
    expect(run('[GNUPG:] FAILURE sign 67109062')).toEqual({ kind: 'gpg-cancelled' });
    expect(run('[GNUPG:] INV_RECP 1 nobody\r\ngpg: nobody: skipped: No public key')).toEqual({
      kind: 'gpg-key-unusable',
      message: 'gpg: nobody: skipped: No public key',
    });
    expect(run('[GNUPG:] KEYEXPIRED 1')).toEqual({ kind: 'gpg-key-unusable', message: '' });
    expect(run('[GNUPG:] FAILURE decrypt 33554433\n  gpg: no valid OpenPGP data found. ')).toEqual({
      kind: 'gpg-failed',
      message: 'gpg: no valid OpenPGP data found.',
    });
    expect(run('')).toEqual({ kind: 'gpg-failed', message: 'gpg exited with 2' });
  });

  it('parses colon listings', () => {
    const listing = [
      'tru::1:1700000000:0:3:1:5',
      'pub:u:255:22:AAAAAAAAAAAAAAAA:1700000000:1900000000::u:::scESC:::::ed25519:::0:',
      'fpr:::::::::1111111111111111111111111111111111111111:',
      'uid:u::::1700000000::HASH::Alice \\x3a\\x29 <alice@example.org>::::::::::0:',
      'uid:u::::1700000000::HASH::Zo\\xc3\\xa9 \u2713 <second@example.org>::::::::::0:',
      'sub:u:255:18:BBBBBBBBBBBBBBBB:1700000000::::::e:::::cv25519::',
      'fpr:::::::::2222222222222222222222222222222222222222:',
      'pub:e:255:22:CCCCCCCCCCCCCCCC:1600000000:1650000000::-:::sc:::::ed25519:::0:',
      'fpr:::::::::3333333333333333333333333333333333333333:',
      'uid:e::::1600000000::HASH::Expired <old@example.org>::::::::::0:',
      'pub:-:255:22:DDDDDDDDDDDDDDDD:::::::::',
      '',
    ].join('\r\n');
    const keys = parseKeyListing(listing, new Set(['1111111111111111111111111111111111111111']));
    expect(keys).toEqual([
      {
        fingerprint: '1111111111111111111111111111111111111111',
        keyId: 'AAAAAAAAAAAAAAAA',
        uids: ['Alice :) <alice@example.org>', 'Zoé \u2713 <second@example.org>'],
        canEncrypt: true,
        hasSecret: true,
        expired: false,
        created: 1_700_000_000,
        expires: 1_900_000_000,
      },
      {
        fingerprint: '3333333333333333333333333333333333333333',
        keyId: 'CCCCCCCCCCCCCCCC',
        uids: ['Expired <old@example.org>'],
        canEncrypt: false,
        hasSecret: false,
        expired: true,
        created: 1_600_000_000,
        expires: 1_650_000_000,
      },
    ]);
    expect(parseKeyListing('uid:::::::::orphan:', new Set())).toEqual([]);
  });
});

describe('Gpg with failing runners', () => {
  const failing =
    (failure: 'not-found' | 'aborted'): Runner =>
    () =>
      Promise.resolve({ ok: false, error: failure });

  it('reports a missing binary and aborted runs as typed errors', async () => {
    const missing = new Gpg('/nope/gpg', failing('not-found'), {});
    expect(await missing.version()).toEqual({ ok: false, error: { kind: 'gpg-not-found' } });
    expect(await missing.listKeys(false)).toEqual({ ok: false, error: { kind: 'gpg-not-found' } });
    expect(await missing.reloadAgent()).toEqual({ ok: false, error: { kind: 'gpg-not-found' } });
    expect(await missing.importKey(Buffer.from('x'))).toEqual({
      ok: false,
      error: { kind: 'gpg-not-found' },
    });
    expect(await missing.generateKey({ name: 'A', email: 'a@b.c' })).toEqual({
      ok: false,
      error: { kind: 'gpg-not-found' },
    });
    const aborted = new Gpg('gpg', failing('aborted'), {});
    expect(await aborted.decrypt('/tmp/x.gpg')).toEqual({
      ok: false,
      error: { kind: 'cancelled' },
    });
  });

  it('handles odd tool output', async () => {
    const scripted =
      (outputs: { code: number; stdout?: string; stderr?: string }[]): Runner =>
      () => {
        const next = outputs.shift() ?? { code: 0 };
        return Promise.resolve({
          ok: true,
          value: { code: next.code, stdout: next.stdout ?? '', stderr: next.stderr ?? '' },
        });
      };
    expect(await new Gpg('gpg', scripted([{ code: 0, stdout: 'weird' }]), {}).version()).toEqual({
      ok: true,
      value: 'unknown',
    });
    expect(await new Gpg('gpg', scripted([{ code: 0 }]), {}).importKey(Buffer.from(''))).toEqual({
      ok: true,
      value: 0,
    });
    // Key creation succeeded but the key cannot be found afterwards.
    expect(
      await new Gpg('gpg', scripted([{ code: 0 }, { code: 0 }]), {}).generateKey({
        name: 'A',
        email: 'a@b.c',
      }),
    ).toEqual({ ok: false, error: { kind: 'gpg-failed', message: 'key was not created' } });
    expect(
      await new Gpg('gpg', scripted([{ code: 0 }, { code: 2 }]), {}).generateKey({
        name: 'A',
        email: 'a@b.c',
      }),
    ).toMatchObject({ ok: false, error: { kind: 'gpg-failed' } });
    expect(
      await new Gpg('gpg', scripted([{ code: 0 }, { code: 2 }]), {}).listKeys(false),
    ).toMatchObject({ ok: false });
    expect(await new Gpg('gpg', scripted([{ code: 1 }]), {}).reloadAgent()).toMatchObject({
      ok: false,
      error: { kind: 'gpg-failed' },
    });
  });
});

describe('Gpg against a real gpg binary', () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await createSandbox();
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('reports its version', async () => {
    expect(unwrap(await sandbox.gpg.version())).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('creates an ed25519/cv25519 key usable for encryption', async () => {
    expect(unwrap(await sandbox.gpg.listKeys(false))).toEqual([]);
    const key = await sandbox.newKey('Alice Example');
    expect(key.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    expect(key.canEncrypt).toBe(true);
    expect(key.hasSecret).toBe(true);
    expect(key.expired).toBe(false);
    expect(key.uids[0]).toContain('Alice Example <alice.example1@sesame.invalid>');
    const listing = unwrap(
      await runProcess(sandbox.gpg.binary, {
        args: ['--batch', '--with-colons', '--list-keys'],
        env: sandbox.env,
      }),
    );
    expect(listing.stdout).toMatch(/^pub:.*:ed25519:/m);
    expect(listing.stdout).toMatch(/^sub:.*:cv25519:/m);
    expect(unwrap(await sandbox.gpg.listKeys(false)).map((k) => k.fingerprint)).toEqual([
      key.fingerprint,
    ]);
    expect(unwrap(await sandbox.gpg.listKeys(true))).toHaveLength(1);
  });

  it('rejects names and e-mails that could be read as options or uid syntax', async () => {
    for (const [name, email] of [
      ['--batch', 'a@b.c'],
      ['Mallory <x>', 'a@b.c'],
      ['Mallory', '-a@b.c'],
      ['Mallory', 'not-an-email'],
      ['', 'a@b.c'],
    ] as const) {
      expect(await sandbox.gpg.generateKey({ name, email, unprotected: true })).toEqual({
        ok: false,
        error: { kind: 'invalid-argument', message: 'invalid name or e-mail' },
      });
    }
  });

  it('encrypts and decrypts through stdin/stdout only', async () => {
    const key = await sandbox.newKey('Alice');
    const file = path.join(sandbox.root, 'secret.gpg');
    const secret = asPlainSecret('correct horse battery staple\nligne 2 — ünïcödé ✓\n');
    unwrap(await sandbox.gpg.encrypt([keyId(key)], secret, file));
    expect(unwrap(await sandbox.gpg.decrypt(file))).toBe(secret);
    for (const call of sandbox.calls) {
      expect(call.args.join(' ')).not.toContain('correct horse');
    }
  });

  it('fails with typed errors', async () => {
    const key = await sandbox.newKey('Alice');
    const file = path.join(sandbox.root, 'x.gpg');
    expect(await sandbox.gpg.encrypt([], asPlainSecret('x'), file)).toEqual({
      ok: false,
      error: { kind: 'store-not-initialized' },
    });
    const garbage = path.join(sandbox.root, 'garbage.gpg');
    await writeFile(garbage, 'this is not OpenPGP data');
    expect(await sandbox.gpg.decrypt(garbage)).toMatchObject({
      ok: false,
      error: { kind: 'gpg-failed' },
    });
    const aborted = new AbortController();
    aborted.abort();
    unwrap(await sandbox.gpg.encrypt([keyId(key)], asPlainSecret('x'), file));
    expect(await sandbox.gpg.decrypt(file, aborted.signal)).toEqual({
      ok: false,
      error: { kind: 'cancelled' },
    });
  });

  it('exports, imports and reloads the agent', async () => {
    const key = await sandbox.newKey('Alice');
    const exported = unwrap(
      await runProcess(sandbox.gpg.binary, {
        args: ['--batch', '--armor', '--export', key.fingerprint],
        env: sandbox.env,
      }),
    );
    const other = await createSandbox();
    try {
      expect(unwrap(await other.gpg.importKey(Buffer.from(exported.stdout)))).toBe(1);
      const imported = unwrap(await other.gpg.listKeys(false));
      expect(imported).toHaveLength(1);
      expect(imported[0]?.hasSecret).toBe(false);
      expect(unwrap(await other.gpg.listKeys(true))).toEqual([]);
      expect(await other.gpg.importKey(Buffer.from('garbage'))).toMatchObject({ ok: false });
      // An imported key has unknown validity: gpg refuses to encrypt to it in batch mode.
      const file = path.join(other.root, 'x.gpg');
      expect(await other.gpg.encrypt([keyId(key)], asPlainSecret('x'), file)).toMatchObject({
        ok: false,
        error: { kind: 'gpg-key-unusable' },
      });
    } finally {
      await other.cleanup();
    }
    expect(await sandbox.gpg.reloadAgent()).toEqual({ ok: true, value: null });
  });
});
