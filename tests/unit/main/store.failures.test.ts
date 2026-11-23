import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gpg } from '../../../src/main/store/gpg';
import { PasswordStore } from '../../../src/main/store/PasswordStore';
import { resolveInStore } from '../../../src/main/store/paths';
import {
  asFolderPath,
  asPlainSecret,
  FolderPathSchema,
  ROOT_FOLDER,
} from '../../../src/shared/types';
import { createSandbox, entry, keyId, unwrap, type Sandbox } from '../../helpers/gpgEnv';

const secret = asPlainSecret;
const given = { force: false, kind: 'given' } as const;

/** Every step of every operation must surface failures as typed errors. */
describe('PasswordStore failure paths', () => {
  let sandbox: Sandbox;
  let store: PasswordStore;
  const has =
    (...words: string[]) =>
    (args: readonly string[]): boolean =>
      words.every((word) => args.includes(word));
  const gitFailed = { ok: false, error: { kind: 'git-failed', message: 'injected fault' } };
  const gpgFailed = { ok: false, error: { kind: 'gpg-failed', message: 'injected fault' } };

  beforeEach(async () => {
    sandbox = await createSandbox();
    store = sandbox.store;
    const alice = await sandbox.newKey('Alice');
    const bob = await sandbox.newKey('Bob');
    unwrap(await store.init(ROOT_FOLDER, [keyId(alice)]));
    unwrap(await store.gitInit());
    unwrap(await store.init(asFolderPath('team'), [keyId(bob)]));
    unwrap(await store.insert(entry('a'), secret('a'), given));
    unwrap(await store.insert(entry('dir/b'), secret('b'), given));
  });
  afterEach(async () => {
    sandbox.failWhen(null);
    await sandbox.cleanup();
  });

  it('reports git commit failures after each kind of change', async () => {
    sandbox.failWhen(has('commit'));
    expect(await store.insert(entry('c'), secret('c'), given)).toEqual(gitFailed);
    expect(await store.edit(entry('a'), secret('a2'))).toEqual(gitFailed);
    expect(await store.replacePassword(entry('a'), secret('a3'))).toEqual(gitFailed);
    expect(await store.move(entry('a'), entry('a-moved'), false)).toEqual(gitFailed);
    expect(await store.copy(entry('dir'), entry('dir-copy'), false)).toEqual(gitFailed);
    expect(await store.remove(entry('dir-copy'), true)).toEqual(gitFailed);
    expect(await store.init(asFolderPath('other'), [keyId(await sandbox.newKey('Carol'))])).toEqual(
      gitFailed,
    );
    expect(await store.init(asFolderPath('team'), [])).toEqual(gitFailed);
  });

  it('reports a failing re-encryption commit', async () => {
    unwrap(await store.insert(entry('team/t'), secret('t'), given));
    const carol = await sandbox.newKey('Carol');
    let commits = 0;
    sandbox.failWhen((args) => args.includes('commit') && (commits += 1) === 2);
    expect(await store.init(asFolderPath('team'), [keyId(carol)])).toEqual(gitFailed);
  });

  it('reports gpg failures while encrypting', async () => {
    sandbox.failWhen(has('--encrypt'));
    expect(await store.insert(entry('c'), secret('c'), given)).toEqual(gpgFailed);
    expect(await store.edit(entry('a'), secret('a2'))).toEqual(gpgFailed);
    expect(await store.move(entry('a'), entry('team/a'), false)).toEqual(gpgFailed);
    expect(await store.copy(entry('dir'), entry('team/dir'), false)).toEqual(gpgFailed);
    sandbox.failWhen(null);
    expect(unwrap(await store.list()).entries).toEqual(['a', 'dir/b']);
  });

  it('reports gpg failures while decrypting', async () => {
    sandbox.failWhen(has('--decrypt'));
    expect(await store.show(entry('a'))).toEqual(gpgFailed);
    expect(await store.move(entry('a'), entry('team/a'), false)).toEqual(gpgFailed);
    expect(unwrap(await store.grep('a', false))).toEqual([]);
  });

  it('stops grep when gpg disappears or the user cancels pinentry', async () => {
    const withRunner = (stderr: string | null): PasswordStore => {
      const runner: typeof sandbox.runner = (file, options) => {
        if (!options.args.includes('--decrypt')) return sandbox.runner(file, options);
        return Promise.resolve(
          stderr === null
            ? { ok: false, error: 'not-found' }
            : { ok: true, value: { code: 2, stdout: '', stderr } },
        );
      };
      return new PasswordStore(
        sandbox.storeDir,
        new Gpg(sandbox.gpg.binary, runner, sandbox.env),
        sandbox.git,
        sandbox.env,
      );
    };
    expect(await withRunner(null).grep('a', false)).toEqual({
      ok: false,
      error: { kind: 'gpg-not-found' },
    });
    expect(await withRunner('[GNUPG:] ERROR pkdecrypt_failed 83886179').grep('a', false)).toEqual({
      ok: false,
      error: { kind: 'cancelled' },
    });
  });

  it('reports failures of the git initialisation steps', async () => {
    const other = await createSandbox();
    try {
      other.failWhen(has('init'));
      expect(await other.store.gitInit()).toEqual(gitFailed);
      other.failWhen(has('commit'));
      await mkdir(other.storeDir, { recursive: true });
      await writeFile(path.join(other.storeDir, 'x.gpg'), 'x');
      expect(await other.store.gitInit()).toEqual(gitFailed);
      let commits = 0;
      other.failWhen((args) => args.includes('commit') && (commits += 1) === 2);
      await writeFile(path.join(other.storeDir, 'y.gpg'), 'y');
      expect(await other.store.gitInit()).toEqual(gitFailed);
    } finally {
      other.failWhen(null);
      await other.cleanup();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports filesystem permission errors',
    async () => {
      await chmod(path.join(sandbox.storeDir, 'dir'), 0o500);
      try {
        expect(await store.remove(entry('dir/b'), false)).toMatchObject({
          ok: false,
          error: { kind: 'io', message: 'EACCES' },
        });
        expect(await store.move(entry('dir/b'), entry('moved'), false)).toMatchObject({
          ok: false,
          error: { kind: 'io' },
        });
        expect(
          await store.init(asFolderPath('dir/sub'), [keyId(await sandbox.newKey('C'))]),
        ).toMatchObject({
          ok: false,
          error: { kind: 'io' },
        });
      } finally {
        await chmod(path.join(sandbox.storeDir, 'dir'), 0o700);
      }
    },
  );

  it('propagates path resolution failures from every operation', async () => {
    const refused = { ok: false, error: { kind: 'invalid-path', reason: 'traversal' } } as const;
    const strict = new PasswordStore(
      sandbox.storeDir,
      sandbox.gpg,
      sandbox.git,
      sandbox.env,
      () => refused,
    );
    expect(await strict.list()).toEqual(refused);
    expect(await strict.has(entry('a'))).toBe(false);
    expect(await strict.recipients(ROOT_FOLDER)).toEqual(refused);
    expect(await strict.show(entry('a'))).toEqual(refused);
    expect(await strict.insert(entry('c'), secret('c'), given)).toEqual(refused);
    expect(await strict.edit(entry('a'), secret('x'))).toEqual(refused);
    expect(await strict.replacePassword(entry('a'), secret('x'))).toEqual(refused);
    expect(await strict.remove(entry('a'), false)).toEqual(refused);
    expect(await strict.remove(entry('dir'), true)).toEqual(refused);
    expect(await strict.move(entry('a'), entry('z'), false)).toEqual(refused);
    expect(await strict.copy(entry('a'), entry('z'), false)).toEqual(refused);
    expect(await strict.grep('a', false)).toEqual(refused);
    expect(await strict.init(ROOT_FOLDER, [])).toEqual(refused);
    // Resolution failing for a single role (source dir, target file, target dir).
    for (const failing of [2, 3, 4]) {
      let calls = 0;
      const partial = new PasswordStore(
        sandbox.storeDir,
        sandbox.gpg,
        sandbox.git,
        sandbox.env,
        (dir, name, suffix) =>
          (calls += 1) === failing ? refused : resolveInStore(dir, name, suffix),
      );
      expect(await partial.move(entry('a'), entry('z'), false)).toEqual(refused);
    }
  });

  it('reports filesystem errors that do not depend on permissions', async () => {
    // Target occupied by a directory: the atomic rename fails and the temp file is removed.
    await mkdir(path.join(sandbox.storeDir, 'occupied.gpg'));
    expect(
      await store.insert(entry('occupied'), secret('x'), { force: true, kind: 'given' }),
    ).toMatchObject({
      ok: false,
      error: { kind: 'io' },
    });
    expect(await readdir(sandbox.storeDir)).not.toContainEqual(expect.stringContaining('.tmp-'));
    // A path component is a file.
    expect(
      await store.init(asFolderPath('a.gpg/sub'), [keyId(await sandbox.newKey('C'))]),
    ).toMatchObject({
      ok: false,
      error: { kind: 'io' },
    });
    const blocked = new PasswordStore(
      path.join(sandbox.storeDir, 'a.gpg', 'nested'),
      sandbox.gpg,
      sandbox.git,
      sandbox.env,
    );
    expect(await blocked.gitInit()).toMatchObject({ ok: false, error: { kind: 'io' } });
    const other = await createSandbox();
    try {
      await mkdir(path.join(other.storeDir, '.gitattributes'), { recursive: true });
      expect(await other.store.gitInit()).toMatchObject({ ok: false, error: { kind: 'io' } });
    } finally {
      await other.cleanup();
    }
  });

  it('handles invalid recipients met during transfers and re-encryption', async () => {
    const invalid = {
      ok: false,
      error: { kind: 'invalid-argument', message: 'invalid recipient in .gpg-id' },
    };
    await mkdir(path.join(sandbox.storeDir, 'bad'));
    await writeFile(path.join(sandbox.storeDir, 'bad', '.gpg-id'), '--evil\n');
    expect(await store.move(entry('a'), entry('bad/a'), false)).toEqual(invalid);
    await writeFile(path.join(sandbox.storeDir, 'bad', 'x.gpg'), 'x');
    expect(await store.move(entry('bad/x'), entry('x'), false)).toEqual(invalid);
    expect(await store.init(ROOT_FOLDER, [keyId(await sandbox.newKey('C'))])).toEqual(invalid);
  });

  it('keeps an existing target when a forced folder copy fails, and prunes emptied folders', async () => {
    unwrap(await store.insert(entry('team/keep'), secret('k'), given));
    await writeFile(path.join(sandbox.storeDir, 'dir', 'broken.gpg'), 'not OpenPGP');
    expect(await store.copy(entry('dir'), entry('team'), true)).toMatchObject({
      ok: false,
      error: { kind: 'gpg-failed' },
    });
    expect(await store.has(entry('team/keep'))).toBe(true);
    // Removing the .gpg-id of an otherwise empty folder removes the folder itself.
    const carol = await sandbox.newKey('Carol');
    unwrap(await store.init(asFolderPath('lonely'), [keyId(carol)]));
    expect(unwrap(await store.init(asFolderPath('lonely'), []))).toEqual({ reencrypted: 0 });
    expect(unwrap(await store.list()).folders).not.toContain('lonely');
  });

  it('refuses folder names that are not valid store paths', () => {
    expect(FolderPathSchema.safeParse('../outside').success).toBe(false);
    expect(FolderPathSchema.safeParse('.git').success).toBe(false);
  });
});
