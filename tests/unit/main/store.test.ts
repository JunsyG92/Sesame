import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GpgKey } from '../../../src/shared/schemas';
import {
  asFolderPath,
  asPlainSecret,
  GpgKeyIdSchema,
  ROOT_FOLDER,
} from '../../../src/shared/types';
import {
  createSandbox,
  entry,
  keyId,
  recipientsOf,
  unwrap,
  type Sandbox,
} from '../../helpers/gpgEnv';

const secret = asPlainSecret;
const exists = async (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

describe('PasswordStore', () => {
  let sandbox: Sandbox;
  let alice: GpgKey;
  const file = (name: string): string => path.join(sandbox.storeDir, ...name.split('/')) + '.gpg';
  const subjects = async (): Promise<string[]> =>
    unwrap(await sandbox.git.log(sandbox.storeDir, 100)).map((commit) => commit.subject);

  beforeEach(async () => {
    sandbox = await createSandbox();
    alice = await sandbox.newKey('Alice');
    unwrap(await sandbox.store.init(ROOT_FOLDER, [keyId(alice)]));
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  describe('init and listing', () => {
    it('writes a pass-compatible .gpg-id', async () => {
      expect(await readFile(path.join(sandbox.storeDir, '.gpg-id'), 'utf8')).toBe(
        `${alice.fingerprint}\n`,
      );
      expect(await sandbox.store.exists()).toBe(true);
      expect(await sandbox.store.isInitialized()).toBe(true);
      expect(await sandbox.store.isGitRepo()).toBe(false);
    });

    it('reports an uninitialised or missing store', async () => {
      const other = await createSandbox();
      try {
        expect(await other.store.exists()).toBe(false);
        expect(await other.store.isInitialized()).toBe(false);
        expect(unwrap(await other.store.list())).toEqual({ entries: [], folders: [] });
        expect(
          await other.store.insert(entry('a'), secret('x'), { force: false, kind: 'given' }),
        ).toEqual({ ok: false, error: { kind: 'store-not-initialized' } });
        expect(unwrap(await other.store.recipients(ROOT_FOLDER))).toEqual({
          ids: [],
          definedIn: null,
          own: false,
        });
      } finally {
        await other.cleanup();
      }
    });

    it('lists entries and folders without decrypting, ignoring foreign files', async () => {
      for (const name of ['web/github.com/alice', 'web/gitlab', 'bank', 'Zeta', 'host:8080']) {
        unwrap(
          await sandbox.store.insert(entry(name === 'host:8080' ? 'host' : name), secret('x'), {
            force: false,
            kind: 'given',
          }),
        );
      }
      await mkdir(path.join(sandbox.storeDir, '.git'), { recursive: true });
      await writeFile(path.join(sandbox.storeDir, '.git', 'trap.gpg'), 'x');
      await writeFile(path.join(sandbox.storeDir, 'README.md'), 'x');
      await writeFile(path.join(sandbox.storeDir, 'web', '.hidden.gpg'), 'x');
      await mkdir(path.join(sandbox.storeDir, 'empty'));
      const decryptionsBefore = sandbox.calls.filter((call) =>
        call.args.includes('--decrypt'),
      ).length;
      expect(unwrap(await sandbox.store.list())).toEqual({
        entries: ['Zeta', 'bank', 'host', 'web/github.com/alice', 'web/gitlab'],
        folders: ['empty', 'web', 'web/github.com'],
      });
      expect(unwrap(await sandbox.store.list(asFolderPath('web')))).toEqual({
        entries: ['web/github.com/alice', 'web/gitlab'],
        folders: ['web/github.com'],
      });
      expect(sandbox.calls.filter((call) => call.args.includes('--decrypt'))).toHaveLength(
        decryptionsBefore,
      );
      expect(await sandbox.store.has(entry('bank'))).toBe(true);
      expect(await sandbox.store.has(entry('web'))).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('follows symlinked folders like pass', async () => {
      const outside = path.join(sandbox.root, 'shared');
      await mkdir(outside);
      await symlink(outside, path.join(sandbox.storeDir, 'team'));
      await symlink(path.join(sandbox.root, 'dangling'), path.join(sandbox.storeDir, 'broken'));
      unwrap(
        await sandbox.store.insert(entry('team/wifi'), secret('x'), {
          force: false,
          kind: 'given',
        }),
      );
      expect(unwrap(await sandbox.store.list())).toEqual({
        entries: ['team/wifi'],
        folders: ['team'],
      });
    });
  });

  describe('insert, show, edit, generate', () => {
    it('round-trips single-line and multi-line content', async () => {
      unwrap(
        await sandbox.store.insert(entry('a'), secret('hunter2'), { force: false, kind: 'given' }),
      );
      expect(unwrap(await sandbox.store.show(entry('a')))).toBe('hunter2\n');
      const multi = 'pässwörd ✓\nlogin: alice\n\nnotes\n';
      unwrap(
        await sandbox.store.insert(entry('deep/er/b'), secret(multi), {
          force: false,
          kind: 'given',
        }),
      );
      expect(unwrap(await sandbox.store.show(entry('deep/er/b')))).toBe(multi);
      expect(await recipientsOf(sandbox, file('a'))).toEqual([alice.fingerprint]);
      // No temporary file is left behind.
      expect((await readdir(sandbox.storeDir)).sort()).toEqual(['.gpg-id', 'a.gpg', 'deep']);
    });

    it('refuses to overwrite unless forced', async () => {
      unwrap(
        await sandbox.store.insert(entry('a'), secret('one'), { force: false, kind: 'given' }),
      );
      expect(
        await sandbox.store.insert(entry('a'), secret('two'), { force: false, kind: 'given' }),
      ).toEqual({ ok: false, error: { kind: 'entry-exists', path: 'a' } });
      expect(unwrap(await sandbox.store.show(entry('a')))).toBe('one\n');
      unwrap(await sandbox.store.insert(entry('a'), secret('two'), { force: true, kind: 'given' }));
      expect(unwrap(await sandbox.store.show(entry('a')))).toBe('two\n');
    });

    it('rejects names that are not portable and reports missing entries', async () => {
      expect(
        await sandbox.store.insert(entry('what?'), secret('x'), { force: false, kind: 'given' }),
      ).toEqual({ ok: false, error: { kind: 'invalid-path', reason: 'forbidden-character' } });
      const missing = { ok: false, error: { kind: 'entry-not-found', path: 'nope' } };
      expect(await sandbox.store.show(entry('nope'))).toEqual(missing);
      expect(await sandbox.store.edit(entry('nope'), secret('x'))).toEqual(missing);
      expect(await sandbox.store.replacePassword(entry('nope'), secret('x'))).toEqual(missing);
      expect(await sandbox.store.remove(entry('nope'), false)).toEqual(missing);
      expect(await sandbox.store.remove(entry('nope'), true)).toEqual(missing);
      expect(await sandbox.store.move(entry('nope'), entry('b'), false)).toEqual(missing);
    });

    it('edits and replaces the password in place', async () => {
      unwrap(
        await sandbox.store.insert(entry('a'), secret('old\nlogin: alice\nnote'), {
          force: false,
          kind: 'given',
        }),
      );
      unwrap(await sandbox.store.replacePassword(entry('a'), secret('new')));
      expect(unwrap(await sandbox.store.show(entry('a')))).toBe('new\nlogin: alice\nnote\n');
      unwrap(await sandbox.store.edit(entry('a'), secret('edited\nurl: example.org')));
      expect(unwrap(await sandbox.store.show(entry('a')))).toBe('edited\nurl: example.org\n');
    });

    it('turns filesystem and gpg failures into typed errors', async () => {
      unwrap(await sandbox.store.insert(entry('a'), secret('x'), { force: false, kind: 'given' }));
      // `a.gpg` is a file, so `a.gpg/b` cannot be created.
      expect(
        await sandbox.store.insert(entry('a.gpg/b'), secret('x'), { force: false, kind: 'given' }),
      ).toMatchObject({ ok: false, error: { kind: 'io' } });
      await writeFile(file('broken'), 'not OpenPGP');
      expect(await sandbox.store.show(entry('broken'))).toMatchObject({
        ok: false,
        error: { kind: 'gpg-failed' },
      });
      expect(await sandbox.store.replacePassword(entry('broken'), secret('x'))).toMatchObject({
        ok: false,
        error: { kind: 'gpg-failed' },
      });
      await writeFile(path.join(sandbox.storeDir, '.gpg-id'), 'nobody@nowhere.invalid\n');
      expect(
        await sandbox.store.insert(entry('c'), secret('x'), { force: false, kind: 'given' }),
      ).toMatchObject({ ok: false, error: { kind: 'gpg-key-unusable' } });
      expect(await sandbox.store.edit(entry('a'), secret('x'))).toMatchObject({
        ok: false,
        error: { kind: 'gpg-key-unusable' },
      });
      expect(await exists(file('c'))).toBe(false);
      expect((await readdir(sandbox.storeDir)).some((name) => name.includes('.tmp-'))).toBe(false);
    });
  });

  describe('.gpg-id handling', () => {
    it('ignores comments and blank lines, rejects option-looking recipients', async () => {
      const idFile = path.join(sandbox.storeDir, '.gpg-id');
      await writeFile(idFile, `# team keys\r\n\r\n${alice.fingerprint} # alice\r\n`);
      unwrap(await sandbox.store.insert(entry('a'), secret('x'), { force: false, kind: 'given' }));
      expect(unwrap(await sandbox.store.recipients(ROOT_FOLDER)).ids).toEqual([alice.fingerprint]);

      await writeFile(idFile, `${alice.fingerprint}\n--no-default-keyring\n`);
      const refused = {
        ok: false,
        error: { kind: 'invalid-argument', message: 'invalid recipient in .gpg-id' },
      };
      expect(
        await sandbox.store.insert(entry('b'), secret('x'), { force: false, kind: 'given' }),
      ).toEqual(refused);
      expect(await sandbox.store.recipients(ROOT_FOLDER)).toEqual(refused);
      expect(await sandbox.store.edit(entry('a'), secret('y'))).toEqual(refused);
      expect(sandbox.calls.some((call) => call.args.includes('--no-default-keyring'))).toBe(false);

      await writeFile(idFile, '# nothing\n');
      expect(
        await sandbox.store.insert(entry('b'), secret('x'), { force: false, kind: 'given' }),
      ).toEqual({ ok: false, error: { kind: 'store-not-initialized' } });
    });

    it('uses the closest .gpg-id and supports several recipients', async () => {
      const bob = await sandbox.newKey('Bob');
      const carol = await sandbox.newKey('Carol');
      unwrap(await sandbox.store.init(asFolderPath('team'), [keyId(bob), keyId(carol)]));
      unwrap(await sandbox.store.init(asFolderPath('team/private/deep'), [keyId(carol)]));
      for (const name of ['solo', 'team/shared', 'team/sub/shared', 'team/private/deep/x']) {
        unwrap(
          await sandbox.store.insert(entry(name), secret('x'), { force: false, kind: 'given' }),
        );
      }
      expect(await recipientsOf(sandbox, file('solo'))).toEqual([alice.fingerprint]);
      const both = [bob.fingerprint, carol.fingerprint].sort();
      expect(await recipientsOf(sandbox, file('team/shared'))).toEqual(both);
      expect(await recipientsOf(sandbox, file('team/sub/shared'))).toEqual(both);
      expect(await recipientsOf(sandbox, file('team/private/deep/x'))).toEqual([carol.fingerprint]);

      expect(unwrap(await sandbox.store.recipients(ROOT_FOLDER))).toEqual({
        ids: [alice.fingerprint],
        definedIn: '',
        own: true,
      });
      expect(unwrap(await sandbox.store.recipients(asFolderPath('team/sub')))).toEqual({
        ids: [bob.fingerprint, carol.fingerprint],
        definedIn: 'team',
        own: false,
      });
      expect(
        unwrap(await sandbox.store.recipients(asFolderPath('team/private/deep'))),
      ).toMatchObject({
        definedIn: 'team/private/deep',
        own: true,
      });
      expect(unwrap(await sandbox.store.recipients(asFolderPath('not/created/yet')))).toMatchObject(
        {
          definedIn: '',
          own: false,
        },
      );
    });

    it('honours PASSWORD_STORE_KEY', async () => {
      const bob = await sandbox.newKey('Bob');
      const store = sandbox.storeWith({
        PASSWORD_STORE_KEY: `${bob.fingerprint}  ${alice.fingerprint}`,
      });
      unwrap(await store.insert(entry('a'), secret('x'), { force: false, kind: 'given' }));
      expect(await recipientsOf(sandbox, file('a'))).toEqual(
        [alice.fingerprint, bob.fingerprint].sort(),
      );
      expect(unwrap(await store.recipients(ROOT_FOLDER))).toMatchObject({
        definedIn: null,
        own: false,
      });
      const bad = sandbox.storeWith({ PASSWORD_STORE_KEY: '--always-trust' });
      expect(
        await bad.insert(entry('b'), secret('x'), { force: false, kind: 'given' }),
      ).toMatchObject({
        ok: false,
        error: { kind: 'invalid-argument' },
      });
      const blank = sandbox.storeWith({ PASSWORD_STORE_KEY: '  ' });
      unwrap(await blank.insert(entry('c'), secret('x'), { force: false, kind: 'given' }));
      expect(await recipientsOf(sandbox, file('c'))).toEqual([alice.fingerprint]);
    });

    it('honours PASSWORD_STORE_GPG_OPTS', async () => {
      const store = sandbox.storeWith({ PASSWORD_STORE_GPG_OPTS: '--armor' });
      unwrap(await store.insert(entry('a'), secret('armored'), { force: false, kind: 'given' }));
      expect(await readFile(file('a'), 'utf8')).toMatch(/^-----BEGIN PGP MESSAGE-----/);
      expect(unwrap(await sandbox.store.show(entry('a')))).toBe('armored\n');
    });
  });

  describe('init re-encryption', () => {
    it('re-encrypts the entries governed by the changed .gpg-id only', async () => {
      const bob = await sandbox.newKey('Bob');
      unwrap(await sandbox.store.init(asFolderPath('team'), [keyId(bob)]));
      for (const name of ['a', 'sub/b', 'team/c']) {
        unwrap(
          await sandbox.store.insert(entry(name), secret(name), { force: false, kind: 'given' }),
        );
      }
      const progress: [number, number][] = [];
      const result = unwrap(
        await sandbox.store.init(ROOT_FOLDER, [keyId(alice), keyId(bob)], {
          onProgress: (done, total) => progress.push([done, total]),
        }),
      );
      expect(result).toEqual({ reencrypted: 2 });
      expect(progress).toEqual([
        [1, 2],
        [2, 2],
      ]);
      const both = [alice.fingerprint, bob.fingerprint].sort();
      expect(await recipientsOf(sandbox, file('a'))).toEqual(both);
      expect(await recipientsOf(sandbox, file('sub/b'))).toEqual(both);
      expect(await recipientsOf(sandbox, file('team/c'))).toEqual([bob.fingerprint]);
      expect(unwrap(await sandbox.store.show(entry('sub/b')))).toBe('sub/b\n');
    });

    it('removes a sub-folder .gpg-id and falls back to the inherited recipients', async () => {
      const bob = await sandbox.newKey('Bob');
      unwrap(await sandbox.store.init(asFolderPath('team'), [keyId(bob)]));
      unwrap(
        await sandbox.store.insert(entry('team/c'), secret('c'), { force: false, kind: 'given' }),
      );
      expect(unwrap(await sandbox.store.init(asFolderPath('team'), []))).toEqual({
        reencrypted: 1,
      });
      expect(await exists(path.join(sandbox.storeDir, 'team', '.gpg-id'))).toBe(false);
      expect(await recipientsOf(sandbox, file('team/c'))).toEqual([alice.fingerprint]);
      expect(await sandbox.store.init(asFolderPath('team'), [])).toEqual({
        ok: false,
        error: { kind: 'invalid-argument', message: 'no .gpg-id to remove' },
      });
      expect(unwrap(await sandbox.store.init(asFolderPath('brand/new'), [keyId(bob)]))).toEqual({
        reencrypted: 0,
      });
    });

    it('can be cancelled and reports failures without corrupting entries', async () => {
      const bob = await sandbox.newKey('Bob');
      unwrap(await sandbox.store.insert(entry('a'), secret('a'), { force: false, kind: 'given' }));
      const controller = new AbortController();
      controller.abort();
      expect(
        await sandbox.store.init(ROOT_FOLDER, [keyId(bob)], { signal: controller.signal }),
      ).toEqual({ ok: false, error: { kind: 'cancelled' } });
      expect(unwrap(await sandbox.store.show(entry('a')))).toBe('a\n');

      const unknown = GpgKeyIdSchema.parse('nobody@nowhere.invalid');
      expect(await sandbox.store.init(ROOT_FOLDER, [unknown])).toMatchObject({
        ok: false,
        error: { kind: 'gpg-key-unusable' },
      });
      expect(unwrap(await sandbox.store.show(entry('a')))).toBe('a\n');
      await writeFile(file('broken'), 'not OpenPGP');
      expect(await sandbox.store.init(ROOT_FOLDER, [keyId(alice)])).toMatchObject({
        ok: false,
        error: { kind: 'gpg-failed' },
      });
    });
  });

  describe('rm', () => {
    it('removes entries and prunes empty folders', async () => {
      for (const name of ['web/a/one', 'web/b', 'keep']) {
        unwrap(
          await sandbox.store.insert(entry(name), secret('x'), { force: false, kind: 'given' }),
        );
      }
      unwrap(await sandbox.store.remove(entry('web/a/one'), false));
      expect(unwrap(await sandbox.store.list())).toEqual({
        entries: ['keep', 'web/b'],
        folders: ['web'],
      });
      expect(await sandbox.store.remove(entry('web'), false)).toMatchObject({
        ok: false,
        error: { kind: 'entry-not-found' },
      });
      unwrap(await sandbox.store.remove(entry('web'), true));
      expect(unwrap(await sandbox.store.list())).toEqual({ entries: ['keep'], folders: [] });
      unwrap(await sandbox.store.remove(entry('keep'), false));
      expect(await sandbox.store.isInitialized()).toBe(true);
    });
  });

  describe('mv and cp', () => {
    it('renames and duplicates entries with identical recipients without re-encrypting', async () => {
      unwrap(
        await sandbox.store.insert(entry('old/a'), secret('one'), { force: false, kind: 'given' }),
      );
      const before = await readFile(file('old/a'));
      unwrap(await sandbox.store.move(entry('old/a'), entry('new/deep/a'), false));
      expect((await readFile(file('new/deep/a'))).equals(before)).toBe(true);
      expect(await exists(path.join(sandbox.storeDir, 'old'))).toBe(false);
      unwrap(await sandbox.store.copy(entry('new/deep/a'), entry('copy'), false));
      expect((await readFile(file('copy'))).equals(before)).toBe(true);
      expect(unwrap(await sandbox.store.list()).entries).toEqual(['copy', 'new/deep/a']);
    });

    it('protects existing targets and overlapping paths', async () => {
      unwrap(await sandbox.store.insert(entry('a'), secret('a'), { force: false, kind: 'given' }));
      unwrap(await sandbox.store.insert(entry('b'), secret('b'), { force: false, kind: 'given' }));
      expect(await sandbox.store.move(entry('a'), entry('b'), false)).toEqual({
        ok: false,
        error: { kind: 'entry-exists', path: 'b' },
      });
      expect(await sandbox.store.copy(entry('a'), entry('b'), false)).toMatchObject({ ok: false });
      const overlap = {
        ok: false,
        error: { kind: 'invalid-argument', message: 'source and destination overlap' },
      };
      expect(await sandbox.store.move(entry('a'), entry('a'), true)).toEqual(overlap);
      expect(await sandbox.store.move(entry('a'), entry('a/inside'), true)).toEqual(overlap);
      expect(await sandbox.store.move(entry('a'), entry('bad|name'), false)).toMatchObject({
        ok: false,
        error: { kind: 'invalid-path' },
      });
      unwrap(await sandbox.store.move(entry('a'), entry('b'), true));
      expect(unwrap(await sandbox.store.show(entry('b')))).toBe('a\n');
      expect(unwrap(await sandbox.store.list()).entries).toEqual(['b']);
    });

    it('re-encrypts when the target folder has other recipients', async () => {
      const bob = await sandbox.newKey('Bob');
      unwrap(await sandbox.store.init(asFolderPath('team'), [keyId(bob)]));
      unwrap(
        await sandbox.store.insert(entry('a'), secret('one'), { force: false, kind: 'given' }),
      );
      unwrap(await sandbox.store.copy(entry('a'), entry('team/copy'), false));
      expect(await recipientsOf(sandbox, file('team/copy'))).toEqual([bob.fingerprint]);
      expect(await exists(file('a'))).toBe(true);
      unwrap(await sandbox.store.move(entry('a'), entry('team/moved'), false));
      expect(await recipientsOf(sandbox, file('team/moved'))).toEqual([bob.fingerprint]);
      expect(await exists(file('a'))).toBe(false);
      expect(unwrap(await sandbox.store.show(entry('team/moved')))).toBe('one\n');
      unwrap(await sandbox.store.move(entry('team/moved'), entry('back'), false));
      expect(await recipientsOf(sandbox, file('back'))).toEqual([alice.fingerprint]);
    });

    it('moves and copies folders, carrying nested .gpg-id files', async () => {
      const bob = await sandbox.newKey('Bob');
      unwrap(await sandbox.store.init(asFolderPath('src/own'), [keyId(bob)]));
      unwrap(await sandbox.store.init(asFolderPath('team'), [keyId(bob)]));
      for (const name of ['src/a', 'src/sub/b', 'src/own/c']) {
        unwrap(
          await sandbox.store.insert(entry(name), secret(name), { force: false, kind: 'given' }),
        );
      }
      await writeFile(path.join(sandbox.storeDir, 'src', 'notes.txt'), 'not an entry');

      unwrap(await sandbox.store.copy(entry('src'), entry('dup'), false));
      expect(unwrap(await sandbox.store.list(asFolderPath('dup'))).entries).toEqual([
        'dup/a',
        'dup/own/c',
        'dup/sub/b',
      ]);
      expect(await recipientsOf(sandbox, file('dup/own/c'))).toEqual([bob.fingerprint]);
      expect(await recipientsOf(sandbox, file('dup/a'))).toEqual([alice.fingerprint]);
      expect(await sandbox.store.copy(entry('src'), entry('dup'), false)).toMatchObject({
        ok: false,
        error: { kind: 'entry-exists' },
      });

      unwrap(await sandbox.store.move(entry('src'), entry('team/src'), false));
      expect(await exists(path.join(sandbox.storeDir, 'src'))).toBe(false);
      expect(await recipientsOf(sandbox, file('team/src/a'))).toEqual([bob.fingerprint]);
      expect(await recipientsOf(sandbox, file('team/src/sub/b'))).toEqual([bob.fingerprint]);
      expect(await recipientsOf(sandbox, file('team/src/own/c'))).toEqual([bob.fingerprint]);
      expect(unwrap(await sandbox.store.show(entry('team/src/sub/b')))).toBe('src/sub/b\n');
    });

    it('stops a folder transfer on the first failure', async () => {
      unwrap(
        await sandbox.store.insert(entry('src/a'), secret('a'), { force: false, kind: 'given' }),
      );
      await writeFile(file('src/broken'), 'not OpenPGP');
      const bob = await sandbox.newKey('Bob');
      unwrap(await sandbox.store.init(asFolderPath('team'), [keyId(bob)]));
      expect(await sandbox.store.move(entry('src'), entry('team/src'), false)).toMatchObject({
        ok: false,
        error: { kind: 'gpg-failed' },
      });
      // Nothing was moved: the source is intact and no partial target is left.
      expect(unwrap(await sandbox.store.list()).entries).toEqual(['src/a', 'src/broken']);
      expect(await exists(path.join(sandbox.storeDir, 'team', 'src'))).toBe(false);
      await writeFile(path.join(sandbox.storeDir, 'team', '.gpg-id'), 'nobody@nowhere.invalid\n');
      expect(await sandbox.store.copy(entry('src/a'), entry('team/a'), false)).toMatchObject({
        ok: false,
        error: { kind: 'gpg-key-unusable' },
      });
    });
  });

  describe('grep', () => {
    beforeEach(async () => {
      unwrap(
        await sandbox.store.insert(
          entry('web/a'),
          secret('needle-pw\nlogin: Alice\nnote NEEDLE\npin: needle-1234'),
          {
            force: false,
            kind: 'given',
          },
        ),
      );
      unwrap(
        await sandbox.store.insert(entry('web/b'), secret('other\nlogin: bob'), {
          force: false,
          kind: 'given',
        }),
      );
    });

    it('finds matching lines and never returns the password line in clear', async () => {
      const progress: [number, number][] = [];
      const matches = unwrap(
        await sandbox.store.grep('needle', false, { onProgress: (d, t) => progress.push([d, t]) }),
      );
      expect(matches).toEqual([
        {
          path: 'web/a',
          lines: [
            { line: 1, text: '', masked: true },
            { line: 3, text: 'note NEEDLE', masked: false },
            { line: 4, text: '', masked: true },
          ],
        },
      ]);
      expect(progress).toEqual([
        [1, 2],
        [2, 2],
      ]);
      expect(JSON.stringify(matches)).not.toContain('needle-pw');
      expect(JSON.stringify(matches)).not.toContain('needle-1234');
    });

    it('supports regular expressions', async () => {
      const matches = unwrap(await sandbox.store.grep('^login: (alice|bob)$', true));
      expect(matches.map((match) => match.path)).toEqual(['web/a', 'web/b']);
      expect(await sandbox.store.grep('(', true)).toEqual({
        ok: false,
        error: { kind: 'invalid-argument', message: 'invalid regular expression' },
      });
      expect(unwrap(await sandbox.store.grep('nothing-matches', false))).toEqual([]);
    });

    it('skips undecryptable entries and can be cancelled', async () => {
      await writeFile(file('web/broken'), 'not OpenPGP');
      expect(unwrap(await sandbox.store.grep('bob', false)).map((match) => match.path)).toEqual([
        'web/b',
      ]);
      const controller = new AbortController();
      const cancelled = await sandbox.store.grep('bob', false, {
        signal: controller.signal,
        onProgress: () => {
          controller.abort();
        },
      });
      expect(cancelled).toEqual({ ok: false, error: { kind: 'cancelled' } });
    });
  });

  describe('git integration', () => {
    it('creates the same commits as pass for every operation', async () => {
      unwrap(await sandbox.store.gitInit());
      expect(await sandbox.store.isGitRepo()).toBe(true);
      expect(await readFile(path.join(sandbox.storeDir, '.gitattributes'), 'utf8')).toBe(
        '*.gpg diff=gpg\n',
      );
      const bob = await sandbox.newKey('Bob');
      unwrap(
        await sandbox.store.insert(entry('web/a'), secret('x'), { force: false, kind: 'given' }),
      );
      unwrap(
        await sandbox.store.insert(entry('gen'), secret('x'), { force: false, kind: 'generated' }),
      );
      unwrap(await sandbox.store.replacePassword(entry('gen'), secret('y')));
      unwrap(await sandbox.store.edit(entry('web/a'), secret('z')));
      unwrap(await sandbox.store.move(entry('web/a'), entry('web/b'), false));
      unwrap(await sandbox.store.copy(entry('web/b'), entry('web/c'), false));
      unwrap(await sandbox.store.remove(entry('web/c'), false));
      unwrap(await sandbox.store.init(asFolderPath('web'), [keyId(bob)]));
      unwrap(await sandbox.store.init(asFolderPath('web'), []));
      unwrap(await sandbox.store.remove(entry('web'), true));
      expect((await subjects()).reverse()).toEqual([
        'Add current contents of password store.',
        'Configure git repository for gpg file diff.',
        'Add given password for web/a to store.',
        'Add generated password for gen.',
        'Replace generated password for gen.',
        'Edit password for web/a using Sesame.',
        'Rename web/a to web/b.',
        'Copy web/b to web/c.',
        'Remove web/c from store.',
        `Set GPG id to ${bob.fingerprint} (web).`,
        `Reencrypt password store using new GPG id ${bob.fingerprint}.`,
        'Deinitialize web.',
        'Reencrypt password store using inherited GPG id.',
        'Remove web from store.',
      ]);
      expect(unwrap(await sandbox.git.status(sandbox.storeDir)).changes).toEqual([]);
    });

    it('can initialise git before the store exists', async () => {
      const other = await createSandbox();
      try {
        unwrap(await other.store.gitInit());
        expect(await other.store.isGitRepo()).toBe(true);
        const key = await other.newKey('Dora');
        unwrap(await other.store.init(ROOT_FOLDER, [keyId(key)]));
        expect(unwrap(await other.git.log(other.storeDir, 1))[0]?.subject).toBe(
          `Set GPG id to ${key.fingerprint}.`,
        );
      } finally {
        await other.cleanup();
      }
    });
  });
});
