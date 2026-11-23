import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProcess } from '../../../src/main/exec';
import { parseEntryPath } from '../../../src/main/store/paths';
import { asPlainSecret, ROOT_FOLDER } from '../../../src/shared/types';
import { createSandbox, entry, keyId, unwrap, type Sandbox } from '../../helpers/gpgEnv';

const SECRET = 'S3cr3t-Canary-9f8e7d6c5b4a';

describe('security', () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await createSandbox();
    const key = await sandbox.newKey('Alice');
    unwrap(await sandbox.store.init(ROOT_FOLDER, [keyId(key)]));
    unwrap(await sandbox.store.gitInit());
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('rejects path traversal attempts before touching the filesystem', async () => {
    const attempts = [
      '../outside',
      '../../etc/passwd',
      'a/../../outside',
      '..\\..\\outside',
      '/etc/passwd',
      'C:\\Windows\\system32\\x',
      '.git/hooks/pre-commit',
      '.gpg-id',
      'a/.git/config',
      'a\u0000b',
      'a/./../b',
    ];
    for (const attempt of attempts) {
      expect(parseEntryPath(attempt).ok, attempt).toBe(false);
      expect(parseEntryPath(attempt, 'existing').ok || attempt.startsWith('C:'), attempt).toBe(
        attempt.startsWith('C:'),
      );
    }
    expect((await readdir(sandbox.root)).filter((name) => name !== 'gitconfig').sort()).toEqual([
      'g',
      'store',
    ]);
  });

  it('treats option-looking entry names as plain names for gpg and git', async () => {
    const names = [
      '--homedir',
      '-rf',
      '--no-verify',
      '--exec=touch pwned',
      '-c core.pager=evil',
      '--',
    ];
    for (const name of names) {
      unwrap(
        await sandbox.store.insert(entry(name), asPlainSecret(`${SECRET}-${name}`), {
          force: false,
          kind: 'given',
        }),
      );
      expect(unwrap(await sandbox.store.show(entry(name)))).toBe(`${SECRET}-${name}\n`);
    }
    unwrap(await sandbox.store.move(entry('--homedir'), entry('--moved'), false));
    unwrap(await sandbox.store.copy(entry('-rf'), entry('--copied'), false));
    unwrap(await sandbox.store.remove(entry('--no-verify'), false));
    expect(unwrap(await sandbox.store.list()).entries).toEqual(
      ['--', '--copied', '--exec=touch pwned', '--moved', '-c core.pager=evil', '-rf'].sort(),
    );
    // Every gpg/git invocation received absolute file paths: no argument is a bare entry name.
    for (const call of sandbox.calls) {
      // (`--` itself is legitimately used as the end-of-options separator.)
      for (const name of names.filter((n) => n !== '--')) expect(call.args).not.toContain(name);
      expect(call.args).not.toContain('--moved');
    }
    const log = unwrap(await sandbox.git.log(sandbox.storeDir, 50)).map((commit) => commit.subject);
    expect(log).toContain('Add given password for --exec=touch pwned to store.');
    expect((await readdir(sandbox.storeDir)).includes('pwned')).toBe(false);
    expect(unwrap(await sandbox.git.status(sandbox.storeDir)).changes).toEqual([]);
  });

  it('never puts secrets in process arguments, errors, logs or plaintext files', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const content = asPlainSecret(`${SECRET}\nlogin: alice\nnote ${SECRET}`);
    unwrap(await sandbox.store.insert(entry('web/a'), content, { force: false, kind: 'given' }));
    unwrap(await sandbox.store.edit(entry('web/a'), content));
    unwrap(await sandbox.store.replacePassword(entry('web/a'), asPlainSecret(`${SECRET}-2`)));
    unwrap(await sandbox.store.copy(entry('web/a'), entry('web/b'), false));
    unwrap(await sandbox.store.grep(SECRET, false));

    // Typed failures carrying tool diagnostics must not leak content either.
    const failures = [
      await sandbox.store.insert(entry('web/a'), content, { force: false, kind: 'given' }),
      await sandbox.store.insert(entry('bad|name'), content, { force: false, kind: 'given' }),
      await sandbox.store.edit(entry('missing'), content),
      await sandbox
        .storeWith({ PASSWORD_STORE_KEY: 'nobody@nowhere.invalid' })
        .edit(entry('web/a'), content),
    ];
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      expect(JSON.stringify(failure)).not.toContain(SECRET);
    }

    for (const call of sandbox.calls) {
      expect(call.args.join('\u0000')).not.toContain(SECRET);
      expect(call.file).not.toContain(SECRET);
    }
    // Secrets only ever travelled through stdin of `gpg --encrypt`.
    const carriers = sandbox.calls.filter((call) => call.input.includes(SECRET));
    expect(carriers.length).toBeGreaterThan(0);
    expect(carriers.every((call) => call.args.includes('--encrypt'))).toBe(true);

    for (const spy of consoleSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }

    // Nothing decrypted was written to disk: store, git objects and temp files included.
    const scan = async (dir: string): Promise<void> => {
      for (const child of await readdir(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, child.name);
        if (child.isDirectory()) await scan(absolute);
        else if (child.isFile()) {
          expect((await readFile(absolute)).includes(SECRET), absolute).toBe(false);
        }
      }
    };
    await scan(sandbox.root);
    const history = unwrap(
      await runProcess('git', {
        // `--no-textconv`: pass configures a gpg textconv so that `git diff` can decrypt on demand.
        args: ['-C', sandbox.storeDir, 'log', '-p', '--all', '--text', '--no-textconv'],
        env: sandbox.env,
      }),
    );
    expect(history.stdout).not.toContain(SECRET);
  });

  it('does not let gpg options be injected through PASSWORD_STORE_GPG_OPTS-free paths', async () => {
    // A hostile `.gpg-id` pulled from a shared repository cannot add gpg options.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      path.join(sandbox.storeDir, '.gpg-id'),
      '--output=/tmp/pwned\n--recipient-file=/etc/passwd\n',
    );
    const before = sandbox.calls.length;
    expect(
      await sandbox.store.insert(entry('x'), asPlainSecret(SECRET), {
        force: false,
        kind: 'given',
      }),
    ).toMatchObject({ ok: false, error: { kind: 'invalid-argument' } });
    expect(sandbox.calls.slice(before).filter((call) => call.args.includes('--encrypt'))).toEqual(
      [],
    );
  });
});
