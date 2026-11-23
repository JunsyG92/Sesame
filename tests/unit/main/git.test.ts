import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runProcess, type Runner } from '../../../src/main/exec';
import { Git, isSafeGitUrl } from '../../../src/main/store/git';
import { createSandbox, unwrap, type Sandbox } from '../../helpers/gpgEnv';

describe('isSafeGitUrl', () => {
  it.each([
    'https://github.com/me/store.git',
    'ssh://git@example.org:2222/me/store.git',
    'git@github.com:me/store.git',
    'git://example.org/store.git',
    path.resolve('/srv/git/store.git'),
  ])('accepts %s', (url) => {
    expect(isSafeGitUrl(url)).toBe(true);
  });

  it.each([
    '',
    '--upload-pack=touch /tmp/pwned',
    '-oProxyCommand=evil',
    'ext::sh -c "touch /tmp/pwned"',
    'fd::17',
    'https://example.org/a b',
    ' https://example.org/a',
    'https://example.org/\u0000',
    'relative/path',
    'file:///etc',
  ])('rejects %j', (url) => {
    expect(isSafeGitUrl(url)).toBe(false);
  });
});

describe('Git', () => {
  let sandbox: Sandbox;
  let git: Git;
  let repo: string;

  const subjects = async (dir: string): Promise<string[]> =>
    unwrap(await git.log(dir, 50)).map((commit) => commit.subject);

  beforeEach(async () => {
    sandbox = await createSandbox();
    git = sandbox.git;
    repo = path.join(sandbox.root, 'repo');
    await mkdir(repo);
  });
  afterEach(async () => {
    await sandbox.cleanup();
  });

  it('is a no-op outside a repository', async () => {
    expect(await git.isRepo(repo)).toBe(false);
    expect(await git.commit(repo, [repo], 'nothing')).toEqual({ ok: true, value: null });
    expect(unwrap(await git.status(repo))).toEqual({
      isRepo: false,
      branch: null,
      remote: null,
      ahead: 0,
      behind: 0,
      changes: [],
    });
    expect(await git.log(repo, 5)).toEqual({ ok: false, error: { kind: 'not-a-git-repo' } });
    expect(await git.pull(repo)).toEqual({ ok: false, error: { kind: 'not-a-git-repo' } });
    expect(await git.push(repo)).toEqual({ ok: false, error: { kind: 'not-a-git-repo' } });
    expect(await git.setRemote(repo, 'https://example.org/x.git')).toEqual({
      ok: false,
      error: { kind: 'not-a-git-repo' },
    });
  });

  it('initialises like pass and commits staged paths only when something changed', async () => {
    unwrap(await git.init(repo, '/usr/bin/gpg'));
    expect(await git.isRepo(repo)).toBe(true);
    expect(await readFile(path.join(repo, '.git', 'config'), 'utf8')).toContain('[diff "gpg"]');
    expect(unwrap(await git.log(repo, 5))).toEqual([]);

    const file = path.join(repo, 'a.gpg');
    await writeFile(file, 'one');
    await writeFile(path.join(repo, 'untracked.txt'), 'left alone');
    unwrap(await git.commit(repo, [file], 'Add given password for a to store.'));
    unwrap(await git.commit(repo, [file], 'no change, no commit'));
    expect(await subjects(repo)).toEqual(['Add given password for a to store.']);

    const status = unwrap(await git.status(repo));
    expect(status.isRepo).toBe(true);
    expect(status.branch).toMatch(/^(main|master)$/);
    expect(status.remote).toBeNull();
    expect(status.changes).toHaveLength(1);
    expect(status.changes[0]).toContain('untracked.txt');

    await rm(file);
    unwrap(await git.commit(repo, [file], 'Remove a from store.'));
    const log = unwrap(await git.log(repo, 1));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ subject: 'Remove a from store.', author: 'Sesame Test' });
    expect(log[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(log[0]?.date ?? ''))).toBe(false);
  });

  it('never treats file names as options', async () => {
    unwrap(await git.init(repo, 'gpg'));
    const sneaky = path.join(repo, '--force.gpg');
    await writeFile(sneaky, 'x');
    unwrap(await git.commit(repo, ['--force.gpg'], 'Add given password for --force to store.'));
    expect(await subjects(repo)).toEqual(['Add given password for --force to store.']);
  });

  it('pushes, pulls and reports conflicts against a remote', async () => {
    const remote = path.join(sandbox.root, 'remote.git');
    unwrap(
      await runProcess('git', { args: ['init', '--quiet', '--bare', remote], env: sandbox.env }),
    );
    unwrap(await git.init(repo, 'gpg'));
    expect(await git.pull(repo)).toEqual({ ok: false, error: { kind: 'git-no-remote' } });
    expect(await git.push(repo)).toEqual({ ok: false, error: { kind: 'git-no-remote' } });
    expect(await git.setRemote(repo, 'ext::sh -c evil')).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'unsupported git URL' },
    });
    unwrap(await git.setRemote(repo, path.join(sandbox.root, 'wrong.git')));
    unwrap(await git.setRemote(repo, remote));
    expect(unwrap(await git.status(repo)).remote).toBe(remote);

    await writeFile(path.join(repo, 'a.gpg'), 'one');
    unwrap(await git.commit(repo, ['a.gpg'], 'first'));
    unwrap(await git.push(repo));
    expect(unwrap(await git.status(repo))).toMatchObject({ ahead: 0, behind: 0 });

    // A second clone pushes a change.
    const other = path.join(sandbox.root, 'other');
    unwrap(await git.clone(remote, other));
    await writeFile(path.join(other, 'b.gpg'), 'two');
    unwrap(await git.commit(other, ['b.gpg'], 'second'));
    unwrap(await git.push(other));

    // Local commit + pull --rebase integrates both histories.
    await writeFile(path.join(repo, 'c.gpg'), 'three');
    unwrap(await git.commit(repo, ['c.gpg'], 'third'));
    expect(await git.push(repo)).toEqual({ ok: false, error: { kind: 'git-conflict' } });
    unwrap(await git.pull(repo));
    expect(await subjects(repo)).toEqual(['third', 'second', 'first']);
    expect(unwrap(await git.status(repo))).toMatchObject({ ahead: 1, behind: 0 });
    unwrap(await git.push(repo));

    // Divergent edits of the same file: the rebase is aborted and the store is intact.
    await writeFile(path.join(other, 'a.gpg'), 'theirs');
    unwrap(await git.commit(other, ['a.gpg'], 'theirs'));
    expect(await git.push(other)).toEqual({ ok: false, error: { kind: 'git-conflict' } });
    unwrap(await git.pull(other));
    await writeFile(path.join(other, 'a.gpg'), 'theirs again');
    unwrap(await git.commit(other, ['a.gpg'], 'theirs again'));
    unwrap(await git.push(other));
    await writeFile(path.join(repo, 'a.gpg'), 'ours');
    unwrap(await git.commit(repo, ['a.gpg'], 'ours'));
    expect(await git.pull(repo)).toEqual({ ok: false, error: { kind: 'git-conflict' } });
    expect(await readFile(path.join(repo, 'a.gpg'), 'utf8')).toBe('ours');
    expect(unwrap(await git.status(repo)).changes).toEqual([]);
  });

  it('reports clone and remote failures', async () => {
    expect(await git.clone('--upload-pack=evil', path.join(sandbox.root, 'x'))).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'unsupported git URL' },
    });
    expect(
      await git.clone(path.join(sandbox.root, 'missing.git'), path.join(sandbox.root, 'x')),
    ).toMatchObject({ ok: false, error: { kind: 'git-failed' } });
    unwrap(await git.init(repo, 'gpg'));
    unwrap(await git.setRemote(repo, path.join(sandbox.root, 'missing.git')));
    expect(await git.pull(repo)).toMatchObject({ ok: false, error: { kind: 'git-failed' } });
    expect(await git.push(repo)).toMatchObject({ ok: false, error: { kind: 'git-failed' } });
  });

  it('reports a missing git binary', async () => {
    const missing = new Git(sandbox.runner, sandbox.env, path.join(sandbox.root, 'no-git'));
    await mkdir(path.join(repo, '.git'));
    const notFound = { ok: false, error: { kind: 'git-not-found' } };
    expect(await missing.commit(repo, ['a'], 'm')).toEqual(notFound);
    expect(await missing.status(repo)).toEqual(notFound);
    expect(await missing.log(repo, 1)).toEqual(notFound);
    expect(await missing.pull(repo)).toEqual(notFound);
    expect(await missing.push(repo)).toEqual(notFound);
    expect(await missing.setRemote(repo, 'https://example.org/x.git')).toEqual(notFound);
    expect(await missing.init(repo, 'gpg')).toEqual(notFound);
    expect(await missing.clone('https://example.org/x.git', repo)).toEqual(notFound);
  });

  it('surfaces failures of individual git steps', async () => {
    const failAt = (failingCommand: string): Git => {
      const runner: Runner = (file, options) =>
        options.args.includes(failingCommand)
          ? Promise.resolve({ ok: true, value: { code: 1, stdout: '', stderr: 'boom' } })
          : runProcess(file, options);
      return new Git(runner, sandbox.env);
    };
    const missingAt = (command: string): Git => {
      const runner: Runner = (file, options) =>
        options.args.includes(command)
          ? Promise.resolve({ ok: false, error: 'not-found' })
          : runProcess(file, options);
      return new Git(runner, sandbox.env);
    };
    const failed = { ok: false, error: { kind: 'git-failed', message: 'boom' } };
    unwrap(await git.init(repo, 'gpg'));
    await writeFile(path.join(repo, 'a.gpg'), 'one');
    expect(await failAt('add').commit(repo, ['a.gpg'], 'm')).toEqual(failed);
    expect(await failAt('commit').commit(repo, ['a.gpg'], 'm')).toEqual(failed);
    expect(await missingAt('diff').commit(repo, ['a.gpg'], 'm')).toMatchObject({ ok: false });
    expect(await failAt('status').status(repo)).toEqual(failed);
    expect(await failAt('remote').pull(repo)).toEqual(failed);
    expect(await failAt('config').init(repo, 'gpg')).toEqual(failed);
    unwrap(await git.setRemote(repo, path.join(sandbox.root, 'r.git')));
    expect(await missingAt('pull').pull(repo)).toMatchObject({ ok: false });
    expect(await missingAt('push').push(repo)).toMatchObject({ ok: false });
    expect(await failAt('set-url').setRemote(repo, 'https://example.org/x.git')).toEqual(failed);
  });

  it('honours pass.signcommits', async () => {
    unwrap(await git.init(repo, 'gpg'));
    unwrap(
      await runProcess('git', {
        args: ['-C', repo, 'config', 'pass.signcommits', 'true'],
        env: sandbox.env,
      }),
    );
    await writeFile(path.join(repo, 'a.gpg'), 'one');
    const signing = sandbox.calls.length;
    // No signing key exists in the sandbox: the signed commit must fail, proving `-S` was used.
    expect(await git.commit(repo, ['a.gpg'], 'signed')).toMatchObject({
      ok: false,
      error: { kind: 'git-failed' },
    });
    expect(sandbox.calls.slice(signing).some((call) => call.args.includes('-S'))).toBe(true);
  });
});
