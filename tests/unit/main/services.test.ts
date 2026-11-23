import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLocale } from '../../../src/main/services';
import type { CopyTarget, GpgKey } from '../../../src/shared/schemas';
import { asFolderPath, asPlainSecret, ROOT_FOLDER } from '../../../src/shared/types';
import { createSandbox, entry, keyId, unwrap, type Sandbox } from '../../helpers/gpgEnv';
import { createHarness, hostPlatform, type Harness } from '../../helpers/services';
import { renderQr } from './qr.test';

const OTP = 'otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example';
const secret = asPlainSecret;

describe('Services', () => {
  let sandbox: Sandbox;
  let h: Harness;
  let alice: GpgKey;

  beforeEach(async () => {
    sandbox = await createSandbox();
    alice = await sandbox.newKey('Alice');
    h = await createHarness(sandbox);
  });
  afterEach(async () => {
    h.services.stopAutoLock();
    await sandbox.cleanup();
  });

  const init = async (): Promise<void> => {
    unwrap(
      await h.call('store:init', { id: 'init-1', folder: ROOT_FOLDER, keyIds: [keyId(alice)] }),
    );
  };
  const insert = async (name: string, content: string): Promise<void> => {
    unwrap(
      await h.call('store:insert', {
        path: entry(name),
        content: secret(content),
        kind: 'given',
        force: false,
        copy: false,
      }),
    );
  };

  it('reports the application status', async () => {
    const status = unwrap(await h.call('app:status', undefined));
    expect(status).toMatchObject({
      platform: hostPlatform,
      version: '1.2.3',
      locale: 'fr',
      store: { dir: sandbox.storeDir, exists: false, initialized: false, isGit: false },
      shortcut: { registered: true },
    });
    expect(status.gpg.path).not.toBeNull();
    expect(status.gpg.version).toMatch(/^\d+\./);
    expect(h.calls).toContain(`watch:${sandbox.storeDir}`);
    expect(h.last('store:changed')).toEqual({ entries: [], folders: [] });
    expect(unwrap(await h.call('app:refresh', undefined)).version).toBe('1.2.3');
    expect(resolveLocale('system', 'en-US')).toBe('en');
    expect(resolveLocale('en', 'fr-FR')).toBe('en');
  });

  it('runs the launcher flow: create a missing entry, find it, copy it', async () => {
    await init();
    const generated = unwrap(
      await h.call('store:generate', {
        path: entry('github'),
        options: unwrap(await h.call('settings:get', undefined)).generator,
        inPlace: false,
        force: false,
        copy: true,
      }),
    );
    expect(generated.clearAfterSeconds).toBe(45);
    expect(generated.entropyBits).toBeGreaterThan(150);
    expect(h.clipboard.content).toHaveLength(25);
    expect(h.last('store:changed')?.entries).toEqual(['github']);
    expect(h.last('history:changed')).toEqual({ github: { count: 1, last: 59_000 } });

    const copied = h.clipboard.content;
    h.clipboard.content = '';
    expect(
      unwrap(await h.call('store:copy', { path: entry('github'), target: { what: 'password' } })),
    ).toEqual({
      what: 'password',
      clearAfterSeconds: 45,
    });
    expect(h.clipboard.content).toBe(copied);
    expect(unwrap(await h.call('history:get', undefined)).github?.count).toBe(2);
  });

  it('creates entries from the clipboard and from a form', async () => {
    await init();
    h.clipboard.content = '';
    expect(await h.call('store:insertFromClipboard', { path: entry('a'), force: false })).toEqual({
      ok: false,
      error: { kind: 'clipboard-empty' },
    });
    h.clipboard.content = 'pasted-secret\n';
    expect(unwrap(await h.call('clipboard:peek', { reveal: false }))).toEqual({
      length: 13,
      text: null,
    });
    expect(unwrap(await h.call('clipboard:peek', { reveal: true })).text).toBe('pasted-secret');
    unwrap(await h.call('store:insertFromClipboard', { path: entry('a'), force: false }));
    expect(unwrap(await sandbox.store.show(entry('a')))).toBe('pasted-secret\n');

    unwrap(
      await h.call('store:insert', {
        path: entry('web/b'),
        content: secret('pw\nlogin: bob\nurl: example.org'),
        kind: 'given',
        force: false,
        copy: true,
      }),
    );
    expect(h.clipboard.content).toBe('pw');
    const view = unwrap(await h.call('store:show', { path: entry('web/b') }));
    expect(view).toMatchObject({ password: 'pw', login: 'bob', url: 'example.org', hasOtp: false });
    expect(
      await h.call('store:insert', {
        path: entry('web/b'),
        content: secret('x'),
        kind: 'given',
        force: false,
        copy: false,
      }),
    ).toEqual({ ok: false, error: { kind: 'entry-exists', path: 'web/b' } });
  });

  it('copies logins, lines and OTP codes and opens URLs', async () => {
    await init();
    await insert('web/github.com/alice', `pw\nurl: https://github.com\n${OTP}\nnote`);
    await insert('nologin', 'pw\nurl: javascript:alert(1)');
    const copy = (name: string, target: CopyTarget) =>
      h.call('store:copy', { path: entry(name), target });
    unwrap(await copy('web/github.com/alice', { what: 'login' }));
    expect(h.clipboard.content).toBe('alice');
    unwrap(await copy('web/github.com/alice', { what: 'line', line: 4 }));
    expect(h.clipboard.content).toBe('note');
    expect(await copy('web/github.com/alice', { what: 'line', line: 9 })).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'no such line' },
    });
    unwrap(await copy('web/github.com/alice', { what: 'otp' }));
    expect(h.clipboard.content).toBe('287082');
    expect(unwrap(await h.call('otp:code', { path: entry('web/github.com/alice') }))).toEqual({
      code: '287082',
      period: 30,
      remaining: 1,
    });
    expect(await copy('nologin', { what: 'otp' })).toEqual({
      ok: false,
      error: { kind: 'otp-missing' },
    });
    expect(await h.call('otp:code', { path: entry('nologin') })).toEqual({
      ok: false,
      error: { kind: 'otp-missing' },
    });

    unwrap(await h.call('store:openUrl', { path: entry('web/github.com/alice') }));
    expect(h.opened).toEqual(['https://github.com/']);
    expect(await h.call('store:openUrl', { path: entry('nologin') })).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'no valid URL' },
    });
    expect(
      await h.call('store:copy', { path: entry('missing'), target: { what: 'password' } }),
    ).toEqual({
      ok: false,
      error: { kind: 'entry-not-found', path: 'missing' },
    });
  });

  it('manages OTP URIs, by text, image and screen capture', async () => {
    await init();
    await insert('a', 'pw\nlogin: x');
    expect(await h.call('otp:setUri', { path: entry('a'), uri: secret('https://nope') })).toEqual({
      ok: false,
      error: { kind: 'otp-invalid' },
    });
    unwrap(await h.call('otp:setUri', { path: entry('a'), uri: secret(` ${OTP} `) }));
    expect(unwrap(await sandbox.store.show(entry('a')))).toBe(`pw\nlogin: x\n${OTP}\n`);
    expect(await h.call('otp:setUri', { path: entry('missing'), uri: secret(OTP) })).toMatchObject({
      ok: false,
    });

    expect(await h.call('otp:importImage', { path: entry('a') })).toEqual({
      ok: false,
      error: { kind: 'cancelled' },
    });
    h.chosenFile = '/tmp/qr.png';
    expect(await h.call('otp:importImage', { path: entry('a') })).toEqual({
      ok: false,
      error: { kind: 'qr-not-found' },
    });
    const other = OTP.replace('alice', 'bob');
    h.image = renderQr(other);
    unwrap(await h.call('otp:importImage', { path: entry('a') }));
    expect(unwrap(await sandbox.store.show(entry('a')))).toContain('Example:bob');

    h.screens = [renderQr('https://not-otp.example'), renderQr(OTP)];
    unwrap(await h.call('otp:importScreen', { path: entry('a') }));
    expect(unwrap(await sandbox.store.show(entry('a')))).toContain('Example:alice');

    const qr = unwrap(await h.call('store:qr', { path: entry('a'), target: 'otp' }));
    expect(qr.dataUrl).toMatch(/^data:image\/png;base64,/);
    unwrap(await h.call('store:qr', { path: entry('a'), target: 'password' }));
    await insert('plain', 'pw');
    expect(await h.call('store:qr', { path: entry('plain'), target: 'otp' })).toEqual({
      ok: false,
      error: { kind: 'otp-missing' },
    });
    await insert('empty', '');
    expect(await h.call('store:qr', { path: entry('empty'), target: 'password' })).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'nothing to encode' },
    });
    expect(await h.call('store:qr', { path: entry('missing'), target: 'password' })).toMatchObject({
      ok: false,
    });
  });

  it('edits, generates in place, moves, duplicates and removes', async () => {
    await init();
    await insert('a', 'old\nlogin: x');
    unwrap(await h.call('store:edit', { path: entry('a'), content: secret('edited\nlogin: x') }));
    const regenerated = unwrap(
      await h.call('store:generate', {
        path: entry('a'),
        options: { mode: 'pin', length: 6 },
        inPlace: true,
        force: false,
        copy: false,
      }),
    );
    expect(regenerated.entropyBits).toBeCloseTo(6 * Math.log2(10));
    expect(unwrap(await sandbox.store.show(entry('a')))).toMatch(/^\d{6}\nlogin: x\n$/);
    expect(
      await h.call('store:generate', {
        path: entry('b'),
        options: {
          mode: 'chars',
          length: 8,
          upper: false,
          lower: false,
          digits: false,
          symbols: false,
          excludeAmbiguous: false,
          exclude: '',
        },
        inPlace: false,
        force: false,
        copy: false,
      }),
    ).toMatchObject({ ok: false, error: { kind: 'invalid-argument' } });
    expect(
      await h.call('store:generate', {
        path: entry('a'),
        options: { mode: 'pin', length: 6 },
        inPlace: false,
        force: false,
        copy: false,
      }),
    ).toEqual({ ok: false, error: { kind: 'entry-exists', path: 'a' } });

    unwrap(await h.call('store:copy', { path: entry('a'), target: { what: 'password' } }));
    unwrap(await h.call('store:move', { from: entry('a'), to: entry('dir/a'), force: false }));
    expect(h.last('history:changed')).toHaveProperty(['dir/a']);
    unwrap(
      await h.call('store:duplicate', { from: entry('dir/a'), to: entry('dir/b'), force: false }),
    );
    expect(h.last('store:changed')?.entries).toEqual(['dir/a', 'dir/b']);
    unwrap(await h.call('store:remove', { path: entry('dir'), recursive: true }));
    expect(h.last('history:changed')).toEqual({});
    expect(h.last('store:changed')).toEqual({ entries: [], folders: [] });
    expect(await h.call('store:remove', { path: entry('dir'), recursive: true })).toMatchObject({
      ok: false,
    });
    expect(
      await h.call('store:move', { from: entry('x'), to: entry('y'), force: false }),
    ).toMatchObject({ ok: false });
  });

  it('greps with progress and cancellation, manages recipients', async () => {
    await init();
    await insert('a', 'pw\nlogin: needle');
    await insert('b', 'pw\nnothing');
    expect(
      unwrap(await h.call('store:grep', { id: 'g1', pattern: 'needle', regex: false })),
    ).toEqual([{ path: 'a', lines: [{ line: 2, text: 'login: needle', masked: false }] }]);
    expect(h.events.filter((e) => e.event === 'job:progress').map((e) => e.payload)).toEqual([
      { id: 'g1', done: 1, total: 2 },
      { id: 'g1', done: 2, total: 2 },
    ]);
    const pending = h.call('store:grep', { id: 'g2', pattern: 'x', regex: false });
    unwrap(await h.call('store:cancelJob', { id: 'g2' }));
    expect(await pending).toEqual({ ok: false, error: { kind: 'cancelled' } });
    unwrap(await h.call('store:cancelJob', { id: 'unknown' }));

    const bob = await sandbox.newKey('Bob');
    expect(
      unwrap(
        await h.call('store:init', {
          id: 'i2',
          folder: asFolderPath('team'),
          keyIds: [keyId(bob)],
        }),
      ),
    ).toEqual({ reencrypted: 0 });
    expect(unwrap(await h.call('store:recipients', { folder: asFolderPath('team') }))).toEqual({
      ids: [bob.fingerprint],
      definedIn: 'team',
      own: true,
    });
    expect(
      unwrap(await h.call('gpg:listKeys', { secretOnly: true })).map((k) => k.uids[0]),
    ).toEqual([expect.stringContaining('Alice'), expect.stringContaining('Bob')]);
  });

  it('generates and imports keys', async () => {
    // Without the test switch, the passphrase is requested through pinentry,
    // which does not exist in a headless sandbox.
    expect(
      await h.call('gpg:generateKey', { name: 'Zoé', email: 'zoe@example.org' }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'gpg-failed' },
    });
    h = await createHarness(sandbox, {
      env: { ...sandbox.env, SESAME_TEST_UNPROTECTED_KEYS: '1' },
    });
    const created = unwrap(
      await h.call('gpg:generateKey', { name: 'Zoé', email: 'zoe@example.org' }),
    );
    expect(created.uids[0]).toBe('Zoé <zoe@example.org>');
    expect(await h.call('gpg:importKey', undefined)).toEqual({
      ok: false,
      error: { kind: 'cancelled' },
    });
    h.chosenFile = path.join(sandbox.root, 'missing.asc');
    expect(await h.call('gpg:importKey', undefined)).toEqual({
      ok: false,
      error: { kind: 'io', message: 'cannot read key file' },
    });
    const big = path.join(sandbox.root, 'big.asc');
    await writeFile(big, Buffer.alloc(2 * 1024 * 1024));
    h.chosenFile = big;
    expect(await h.call('gpg:importKey', undefined)).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'key file too large' },
    });
    const other = await createSandbox();
    try {
      const key = await other.newKey('Imported');
      const exported = path.join(sandbox.root, 'key.asc');
      const { runProcess } = await import('../../../src/main/exec');
      const armored = unwrap(
        await runProcess(other.gpg.binary, {
          args: ['--armor', '--export', key.fingerprint],
          env: other.env,
        }),
      );
      await writeFile(exported, armored.stdout);
      h.chosenFile = exported;
      expect(unwrap(await h.call('gpg:importKey', undefined))).toEqual({ imported: 1 });
      h.chosenFile = big;
      await writeFile(big, 'garbage');
      expect(await h.call('gpg:importKey', undefined)).toMatchObject({ ok: false });
    } finally {
      await other.cleanup();
    }
    unwrap(await h.call('gpg:reloadAgent', undefined));
  });

  it('drives git: init, status, log, remote, pull, push, clone', async () => {
    await init();
    unwrap(await h.call('git:init', undefined));
    await insert('a', 'pw');
    const status = unwrap(await h.call('git:status', undefined));
    expect(status).toMatchObject({ isRepo: true, remote: null, changes: [] });
    expect(unwrap(await h.call('git:log', { limit: 2 })).map((c) => c.subject)).toEqual([
      'Add given password for a to store.',
      'Configure git repository for gpg file diff.',
    ]);
    expect(await h.call('git:pull', undefined)).toEqual({
      ok: false,
      error: { kind: 'git-no-remote' },
    });
    expect(await h.call('git:push', undefined)).toEqual({
      ok: false,
      error: { kind: 'git-no-remote' },
    });
    const remote = path.join(sandbox.root, 'remote.git');
    const { runProcess } = await import('../../../src/main/exec');
    unwrap(
      await runProcess('git', { args: ['init', '--quiet', '--bare', remote], env: sandbox.env }),
    );
    unwrap(await h.call('git:setRemote', { url: remote }));
    unwrap(await h.call('git:push', undefined));
    unwrap(await h.call('git:pull', undefined));
    expect(await h.call('git:clone', { url: remote })).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'store directory is not empty' },
    });

    // Clone into a fresh, empty store location (first-run setup on a new machine).
    unwrap(await h.call('settings:update', { storeDir: path.join(sandbox.root, 'clone') }));
    unwrap(await h.call('git:clone', { url: remote }));
    expect(h.last('store:changed')?.entries).toEqual(['a']);
    expect(unwrap(await h.call('app:status', undefined)).store).toMatchObject({
      initialized: true,
      isGit: true,
    });
  });

  it('updates settings, shortcut and autostart', async () => {
    const updated = unwrap(
      await h.call('settings:update', { clipTime: 10, autoStart: true, language: 'en' }),
    );
    expect(updated).toMatchObject({ clipTime: 10, autoStart: true, language: 'en' });
    expect(h.calls).toContain('autostart:true');
    expect(h.last('settings:changed')?.clipTime).toBe(10);
    expect(h.last('status:changed')?.locale).toBe('en');
    h.shortcutAccepted = false;
    expect(await h.call('settings:update', { shortcut: 'Alt+K' })).toEqual({
      ok: false,
      error: { kind: 'shortcut-conflict', accelerator: 'Alt+K' },
    });
    expect(h.settings.value.shortcut).toBe('Control+Shift+Space');
    h.shortcutAccepted = true;
    unwrap(await h.call('settings:update', { shortcut: 'Alt+K' }));
    expect(h.settings.value.shortcut).toBe('Alt+K');
    await init();
    await insert('a', 'pw');
    unwrap(await h.call('store:copy', { path: entry('a'), target: { what: 'password' } }));
    expect(unwrap(await h.call('clipboard:copyText', { text: secret('typed') }))).toEqual({
      what: 'line',
      clearAfterSeconds: 10,
    });
    expect(h.clipboard.content).toBe('typed');
  });

  it('previews generated passwords with a strength score', async () => {
    const preview = unwrap(
      await h.call('generator:preview', {
        mode: 'passphrase',
        words: 6,
        separator: '-',
        capitalize: false,
        addDigit: false,
      }),
    );
    expect(preview.password.split('-')).toHaveLength(6);
    expect(preview.score).toBe(4);
    expect(
      await h.call('generator:preview', {
        mode: 'chars',
        length: 8,
        upper: false,
        lower: false,
        digits: false,
        symbols: false,
        excludeAmbiguous: false,
        exclude: '',
      }),
    ).toMatchObject({ ok: false });
  });

  it('forwards window actions to the ports', async () => {
    unwrap(await h.call('app:openManager', undefined));
    unwrap(await h.call('app:hideLauncher', undefined));
    unwrap(await h.call('app:secretVisible', { visible: true }));
    unwrap(await h.call('app:quit', undefined));
    expect(h.calls.slice(-4)).toEqual(['openManager', 'hideLauncher', 'secret:7:true', 'quit']);
    h.chosenDirectory = '/some/dir';
    h.chosenFile = '/usr/bin/gpg';
    expect(unwrap(await h.call('app:chooseStoreDir', undefined))).toBe('/some/dir');
    expect(unwrap(await h.call('app:chooseGpgBinary', undefined))).toBe('/usr/bin/gpg');
  });

  it('locks after inactivity: clears the clipboard and notifies renderers', async () => {
    vi.useFakeTimers();
    try {
      await init();
      await insert('a', 'pw');
      unwrap(await h.call('settings:update', { autoLockMinutes: 1, reloadAgentOnLock: true }));
      unwrap(await h.call('store:copy', { path: entry('a'), target: { what: 'password' } }));
      h.services.touch();
      h.services.startAutoLock(1000);
      h.now += 30_000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.last('app:lock')).toBeUndefined();
      h.now += 31_000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.events.filter((e) => e.event === 'app:lock')).toHaveLength(1);
      expect(h.clipboard.content).toBe('');
      // Already locked: no repeated notifications.
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.events.filter((e) => e.event === 'app:lock')).toHaveLength(1);
      unwrap(await h.call('settings:update', { autoLockMinutes: 0 }));
      h.services.touch();
      h.now += 10 * 60_000;
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.events.filter((e) => e.event === 'app:lock')).toHaveLength(1);
    } finally {
      h.services.stopAutoLock();
      vi.useRealTimers();
    }
  });
});

describe('Services without gpg', () => {
  let sandbox: Sandbox;
  let h: Harness;
  beforeEach(async () => {
    sandbox = await createSandbox();
    h = await createHarness(sandbox, {
      env: { ...sandbox.env, PATH: '' },
      probe: () => Promise.resolve(false),
    });
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('reports gpg as missing everywhere it is needed', async () => {
    const status = unwrap(await h.call('app:status', undefined));
    expect(status.gpg).toEqual({ path: null, version: null });
    expect(unwrap(await h.call('store:list', undefined))).toEqual({ entries: [], folders: [] });
    const missing = { ok: false, error: { kind: 'gpg-not-found' } };
    const p = entry('a');
    const results = await Promise.all([
      h.call('store:show', { path: p }),
      h.call('store:insert', {
        path: p,
        content: secret('x'),
        kind: 'given',
        force: false,
        copy: false,
      }),
      h.call('store:insertFromClipboard', { path: p, force: false }),
      h.call('store:generate', {
        path: p,
        options: { mode: 'pin', length: 4 },
        inPlace: false,
        force: false,
        copy: false,
      }),
      h.call('store:edit', { path: p, content: secret('x') }),
      h.call('store:remove', { path: p, recursive: false }),
      h.call('store:move', { from: p, to: entry('b'), force: false }),
      h.call('store:duplicate', { from: p, to: entry('b'), force: false }),
      h.call('store:grep', { id: 'x', pattern: 'x', regex: false }),
      h.call('store:recipients', { folder: ROOT_FOLDER }),
      h.call('store:init', { id: 'x', folder: ROOT_FOLDER, keyIds: [] }),
      h.call('otp:setUri', { path: p, uri: secret(OTP) }),
      h.call('gpg:listKeys', { secretOnly: false }),
      h.call('gpg:generateKey', { name: 'A', email: 'a@b.c' }),
      h.call('gpg:importKey', undefined),
      h.call('gpg:reloadAgent', undefined),
      h.call('git:init', undefined),
    ]);
    for (const result of results) expect(result).toEqual(missing);
    expect(unwrap(await h.call('git:status', undefined)).isRepo).toBe(false);
    await h.services.lock();
    expect(h.last('app:lock')).toBeNull();
  });

  it('treats a broken gpg binary as missing', async () => {
    const fake = path.join(sandbox.root, 'fake-gpg');
    await writeFile(fake, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    unwrap(await h.call('settings:update', { gpgPath: fake }));
    expect(unwrap(await h.call('app:status', undefined)).gpg).toEqual({
      path: null,
      version: null,
    });
  });
});
