import { stat } from 'node:fs/promises';
import path from 'node:path';
import { hasControlCharacter } from '../../shared/entryPath';
import type { AppError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import type { GitCommit, GitStatus } from '../../shared/schemas';
import type { RunOutput, Runner } from '../exec';

const FIELD_SEPARATOR = '\u001f';

/**
 * Accepts https/ssh/git URLs, scp-like `user@host:path` and local paths.
 * Rejects option-looking values and git "remote helper" transports
 * (`ext::`, `fd::`…) which can execute arbitrary commands.
 */
export function isSafeGitUrl(url: string): boolean {
  if (url.trim() !== url || url === '' || url.startsWith('-')) return false;
  if (hasControlCharacter(url) || url.includes('::')) return false;
  if (/^(https|http|ssh|git):\/\/[^\s]+$/.test(url)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url)) return true;
  return path.isAbsolute(url);
}

export class Git {
  private readonly env: NodeJS.ProcessEnv;

  public constructor(
    private readonly runner: Runner,
    env: NodeJS.ProcessEnv,
    private readonly binary = 'git',
  ) {
    // Never block on a terminal prompt: credentials come from helpers/ssh-agent.
    this.env = { ...env, GIT_TERMINAL_PROMPT: '0' };
  }

  private async run(dir: string, args: readonly string[]): Promise<Result<RunOutput, AppError>> {
    const result = await this.runner(this.binary, {
      args: ['-C', dir, '-c', 'protocol.ext.allow=never', ...args],
      env: this.env,
    });
    if (!result.ok) return err({ kind: 'git-not-found' });
    return ok(result.value);
  }

  private async mustSucceed(
    dir: string,
    args: readonly string[],
  ): Promise<Result<RunOutput, AppError>> {
    const result = await this.run(dir, args);
    if (!result.ok) return result;
    if (result.value.code !== 0) {
      return err({ kind: 'git-failed', message: result.value.stderr.trim().slice(0, 600) });
    }
    return result;
  }

  /** Like `pass`, git integration is active when the store itself is a repository. */
  public async isRepo(dir: string): Promise<boolean> {
    try {
      await stat(path.join(dir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stages the given paths (additions, changes and deletions) and commits them.
   * Does nothing when the store is not a repository or nothing changed.
   */
  public async commit(
    dir: string,
    files: readonly string[],
    message: string,
  ): Promise<Result<null, AppError>> {
    if (!(await this.isRepo(dir))) return ok(null);
    const added = await this.mustSucceed(dir, ['add', '--all', '--', ...files]);
    if (!added.ok) return added;
    const staged = await this.run(dir, ['diff', '--cached', '--quiet']);
    if (!staged.ok) return staged;
    if (staged.value.code === 0) return ok(null);
    const signing = await this.run(dir, ['config', '--bool', '--get', 'pass.signcommits']);
    const sign = signing.ok && signing.value.stdout.trim() === 'true' ? '-S' : '--no-gpg-sign';
    const committed = await this.mustSucceed(dir, ['commit', sign, '--quiet', '-m', message]);
    return committed.ok ? ok(null) : committed;
  }

  /** `pass git init`: same repository setup and commit messages as pass. */
  public async init(dir: string, gpgBinary: string): Promise<Result<null, AppError>> {
    const steps: (readonly string[])[] = [
      ['init', '--quiet'],
      ['config', '--local', 'diff.gpg.binary', 'true'],
      [
        'config',
        '--local',
        'diff.gpg.textconv',
        `"${gpgBinary}" -d --quiet --yes --compress-algo=none --no-encrypt-to --batch --use-agent`,
      ],
    ];
    for (const step of steps) {
      const result = await this.mustSucceed(dir, step);
      if (!result.ok) return result;
    }
    return ok(null);
  }

  public async status(dir: string): Promise<Result<GitStatus, AppError>> {
    if (!(await this.isRepo(dir))) {
      return ok({ isRepo: false, branch: null, remote: null, ahead: 0, behind: 0, changes: [] });
    }
    const result = await this.mustSucceed(dir, ['status', '--porcelain=v2', '--branch']);
    if (!result.ok) return result;
    let branch: string | null = null;
    let ahead = 0;
    let behind = 0;
    const changes: string[] = [];
    for (const line of result.value.stdout.split('\n')) {
      if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length);
      else if (line.startsWith('# branch.ab ')) {
        const match = /\+(\d+) -(\d+)/.exec(line);
        ahead = Number(match?.[1] ?? 0);
        behind = Number(match?.[2] ?? 0);
      } else if (line !== '' && !line.startsWith('#')) changes.push(line);
    }
    const remote = await this.run(dir, ['remote', 'get-url', 'origin']);
    return ok({
      isRepo: true,
      branch,
      remote: remote.ok && remote.value.code === 0 ? remote.value.stdout.trim() : null,
      ahead,
      behind,
      changes,
    });
  }

  private async requireRemote(dir: string): Promise<Result<null, AppError>> {
    if (!(await this.isRepo(dir))) return err({ kind: 'not-a-git-repo' });
    const remotes = await this.mustSucceed(dir, ['remote']);
    if (!remotes.ok) return remotes;
    return remotes.value.stdout.trim() === '' ? err({ kind: 'git-no-remote' }) : ok(null);
  }

  /** Pull with rebase; on conflict the rebase is aborted so the store stays usable. */
  public async pull(dir: string): Promise<Result<string, AppError>> {
    const ready = await this.requireRemote(dir);
    if (!ready.ok) return ready;
    const result = await this.run(dir, ['pull', '--rebase', '--quiet']);
    if (!result.ok) return result;
    if (result.value.code === 0) return ok(result.value.stdout.trim());
    const rebasing = await this.run(dir, ['rebase', '--abort']);
    if (rebasing.ok && rebasing.value.code === 0) return err({ kind: 'git-conflict' });
    return err({ kind: 'git-failed', message: result.value.stderr.trim().slice(0, 600) });
  }

  public async push(dir: string): Promise<Result<string, AppError>> {
    const ready = await this.requireRemote(dir);
    if (!ready.ok) return ready;
    const result = await this.run(dir, ['push', '--quiet', '--set-upstream', 'origin', 'HEAD']);
    if (!result.ok) return result;
    if (result.value.code === 0) return ok(result.value.stderr.trim());
    const message = result.value.stderr.trim().slice(0, 600);
    if (/rejected|non-fast-forward|fetch first/.test(message)) return err({ kind: 'git-conflict' });
    return err({ kind: 'git-failed', message });
  }

  public async log(dir: string, limit: number): Promise<Result<GitCommit[], AppError>> {
    if (!(await this.isRepo(dir))) return err({ kind: 'not-a-git-repo' });
    const format = ['%H', '%an', '%aI', '%s'].join('%x1f');
    const result = await this.run(dir, [
      'log',
      `--max-count=${String(limit)}`,
      `--pretty=format:${format}`,
    ]);
    if (!result.ok) return result;
    // An empty repository has no HEAD yet: that is an empty history, not an error.
    if (result.value.code !== 0) return ok([]);
    return ok(
      result.value.stdout
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => {
          const [hash = '', author = '', date = '', subject = ''] = line.split(FIELD_SEPARATOR);
          return { hash, author, date, subject };
        }),
    );
  }

  public async setRemote(dir: string, url: string): Promise<Result<null, AppError>> {
    if (!isSafeGitUrl(url))
      return err({ kind: 'invalid-argument', message: 'unsupported git URL' });
    if (!(await this.isRepo(dir))) return err({ kind: 'not-a-git-repo' });
    const existing = await this.run(dir, ['remote', 'get-url', 'origin']);
    if (!existing.ok) return existing;
    const args =
      existing.value.code === 0
        ? ['remote', 'set-url', 'origin', '--', url]
        : ['remote', 'add', '--', 'origin', url];
    const result = await this.mustSucceed(dir, args);
    return result.ok ? ok(null) : result;
  }

  /** Clones a remote store into `dir` (which must not exist or be empty). */
  public async clone(url: string, dir: string): Promise<Result<null, AppError>> {
    if (!isSafeGitUrl(url))
      return err({ kind: 'invalid-argument', message: 'unsupported git URL' });
    const result = await this.mustSucceed(path.dirname(dir), ['clone', '--quiet', '--', url, dir]);
    return result.ok ? ok(null) : result;
  }
}
