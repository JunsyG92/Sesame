import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProcess } from '../../../src/main/exec';
import { asFolderPath, asPlainSecret, ROOT_FOLDER } from '../../../src/shared/types';
import { createSandbox, entry, keyId, unwrap, type Sandbox } from '../../helpers/gpgEnv';

const passAvailable =
  process.platform !== 'win32' &&
  (await runProcess('pass', { args: ['version'] }).then(
    (result) => result.ok && result.value.code === 0,
  ));

/** Interoperability with the reference implementation (https://www.passwordstore.org/). */
describe.runIf(passAvailable)('compatibility with pass', () => {
  let sandbox: Sandbox;
  let passEnv: NodeJS.ProcessEnv;
  const pass = async (args: string[], input?: string): Promise<string> => {
    const result = unwrap(
      await runProcess('pass', { args, env: passEnv, ...(input === undefined ? {} : { input }) }),
    );
    if (result.code !== 0) throw new Error(`pass ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
  };

  beforeEach(async () => {
    sandbox = await createSandbox();
    passEnv = { ...sandbox.env, PASSWORD_STORE_DIR: sandbox.storeDir };
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('pass reads what Sesame writes', async () => {
    const key = await sandbox.newKey('Alice');
    unwrap(await sandbox.store.init(ROOT_FOLDER, [keyId(key)]));
    unwrap(await sandbox.store.gitInit());
    unwrap(
      await sandbox.store.insert(
        entry('web/github.com/alice'),
        asPlainSecret('hunter2\nlogin: alice\nurl: https://github.com'),
        { force: false, kind: 'given' },
      ),
    );
    expect(await pass(['show', 'web/github.com/alice'])).toBe(
      'hunter2\nlogin: alice\nurl: https://github.com\n',
    );
    expect(await pass(['ls'])).toContain('alice');
    expect(await pass(['find', 'github'])).toContain('github.com');
    expect(await pass(['grep', '--color=never', 'login'])).toContain('login: alice');
    // pass can keep working in the repository Sesame initialised.
    await pass(['generate', '--no-symbols', 'web/generated', '20']);
    expect(await pass(['git', 'status', '--porcelain'])).toBe('');
    expect(await pass(['git', 'log', '--format=%s', '-1'])).toBe(
      'Add generated password for web/generated.\n',
    );
  });

  it('Sesame reads what pass writes', async () => {
    const key = await sandbox.newKey('Alice');
    await pass(['init', key.fingerprint]);
    await pass(['git', 'init']);
    await pass(['insert', '--multiline', 'bank/account'], 'pässwörd\nuser: bob\n');
    await pass(['insert', '--echo', 'simple'], 'one-line\n');
    await pass(['generate', 'generated', '32']);
    expect(unwrap(await sandbox.store.list())).toEqual({
      entries: ['bank/account', 'generated', 'simple'],
      folders: ['bank'],
    });
    expect(unwrap(await sandbox.store.show(entry('bank/account')))).toBe('pässwörd\nuser: bob\n');
    expect(unwrap(await sandbox.store.show(entry('simple')))).toBe('one-line\n');
    expect(unwrap(await sandbox.store.show(entry('generated')))).toMatch(/^\S{32}\n$/);
    expect(unwrap(await sandbox.store.recipients(ROOT_FOLDER)).ids).toEqual([key.fingerprint]);

    // Round trip: edit with Sesame, read back with pass, same git history.
    unwrap(await sandbox.store.edit(entry('simple'), asPlainSecret('edited by sesame')));
    unwrap(await sandbox.store.move(entry('simple'), entry('moved/simple'), false));
    expect(await pass(['show', 'moved/simple'])).toBe('edited by sesame\n');
    expect(await pass(['git', 'status', '--porcelain'])).toBe('');
    expect((await pass(['git', 'log', '--format=%s', '-2'])).split('\n').slice(0, 2)).toEqual([
      'Rename simple to moved/simple.',
      'Edit password for simple using Sesame.',
    ]);
  });

  it('agrees with pass on sub-folder recipients', async () => {
    const alice = await sandbox.newKey('Alice');
    const bob = await sandbox.newKey('Bob');
    await pass(['init', alice.fingerprint]);
    await pass(['init', '--path=team', bob.fingerprint]);
    expect(unwrap(await sandbox.store.recipients(asFolderPath('team')))).toEqual({
      ids: [bob.fingerprint],
      definedIn: 'team',
      own: true,
    });
    unwrap(
      await sandbox.store.insert(entry('team/wifi'), asPlainSecret('shared'), {
        force: false,
        kind: 'given',
      }),
    );
    expect(await pass(['show', 'team/wifi'])).toBe('shared\n');
    // Re-initialising with pass re-encrypts Sesame's entry; Sesame still reads it.
    await pass(['init', '--path=team', alice.fingerprint, bob.fingerprint]);
    expect(unwrap(await sandbox.store.show(entry('team/wifi')))).toBe('shared\n');
  });
});
