import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GpgKey } from '../../src/shared/schemas';
import { GpgKeyIdSchema, type EntryPath, type GpgKeyId } from '../../src/shared/types';
import { runProcess, type RunOptions, type Runner } from '../../src/main/exec';
import { Git } from '../../src/main/store/git';
import { findGpg, Gpg } from '../../src/main/store/gpg';
import { PasswordStore } from '../../src/main/store/PasswordStore';
import { parseEntryPath } from '../../src/main/store/paths';

/**
 * Isolated GnuPG + store sandbox for tests: a temporary `GNUPGHOME` with
 * passphrase-less test keys and a temporary store. Nothing touches the real
 * `~/.gnupg` or `~/.password-store`.
 */
export interface Sandbox {
  readonly root: string;
  readonly storeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly gpg: Gpg;
  readonly git: Git;
  readonly store: PasswordStore;
  readonly calls: RecordedCall[];
  readonly runner: Runner;
  /** Fault injection: calls matching the predicate fail with exit code 1. */
  failWhen(predicate: ((args: readonly string[]) => boolean) | null): void;
  newKey(name: string): Promise<GpgKey>;
  storeWith(env: NodeJS.ProcessEnv): PasswordStore;
  cleanup(): Promise<void>;
}

export interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly input: string;
}

export function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
  return result.value;
}

export function entry(name: string): EntryPath {
  return unwrap(parseEntryPath(name, 'existing'));
}

export function keyId(key: GpgKey): GpgKeyId {
  return GpgKeyIdSchema.parse(key.fingerprint);
}

export async function createSandbox(): Promise<Sandbox> {
  // GnuPG sockets live in GNUPGHOME: keep the path short (sun_path limit).
  const root = await mkdtemp(path.join(tmpdir(), 'ssm-'));
  const gnupgHome = path.join(root, 'g');
  const storeDir = path.join(root, 'store');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(gnupgHome, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    APPDATA: process.env.APPDATA,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    GNUPGHOME: gnupgHome,
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Sesame Test',
    GIT_AUTHOR_EMAIL: 'test@sesame.invalid',
    GIT_COMMITTER_NAME: 'Sesame Test',
    GIT_COMMITTER_EMAIL: 'test@sesame.invalid',
  };
  const binary = await findGpg(
    process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    process.env,
    null,
  );
  if (binary === null) throw new Error('gpg is required to run the store tests');
  const calls: RecordedCall[] = [];
  let fault: ((args: readonly string[]) => boolean) | null = null;
  const runner: Runner = (file, options: RunOptions) => {
    calls.push({ file, args: options.args, input: options.input?.toString() ?? '' });
    if (fault?.(options.args) === true) {
      return Promise.resolve({
        ok: true,
        value: { code: 1, stdout: '', stderr: 'injected fault' },
      });
    }
    return runProcess(file, options);
  };
  const gpg = new Gpg(binary, runner, env);
  const git = new Git(runner, env);
  const store = new PasswordStore(storeDir, gpg, git, env);
  let counter = 0;
  return {
    root,
    storeDir,
    env,
    gpg,
    git,
    store,
    calls,
    runner,
    failWhen(predicate) {
      fault = predicate;
    },
    async newKey(name) {
      counter += 1;
      return unwrap(
        await gpg.generateKey({
          name,
          email: `${name.toLowerCase().replaceAll(' ', '.')}${String(counter)}@sesame.invalid`,
          unprotected: true,
        }),
      );
    },
    storeWith(extra) {
      const merged = { ...env, ...extra };
      return new PasswordStore(
        storeDir,
        new Gpg(binary, runner, merged),
        new Git(runner, merged),
        merged,
      );
    },
    async cleanup() {
      await runProcess('gpgconf', { args: ['--kill', 'all'], env });
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

/** Primary fingerprints a `.gpg` file is encrypted to (via its packet key ids). */
export async function recipientsOf(sandbox: Sandbox, file: string): Promise<string[]> {
  const packets = unwrap(
    await runProcess(sandbox.gpg.binary, {
      args: ['--batch', '--list-packets', '--', file],
      env: sandbox.env,
    }),
  );
  const keyIds = [...packets.stdout.matchAll(/keyid ([0-9A-F]{16})/g)].map((match) => match[1]);
  const listing = unwrap(
    await runProcess(sandbox.gpg.binary, {
      args: ['--batch', '--with-colons', '--list-keys'],
      env: sandbox.env,
    }),
  );
  const owners = new Map<string, string>();
  let primary = '';
  let awaitingFingerprint = false;
  for (const line of listing.stdout.split(/\r?\n/)) {
    const fields = line.split(':');
    if (fields[0] === 'pub') awaitingFingerprint = true;
    else if (fields[0] === 'fpr' && awaitingFingerprint) {
      primary = fields[9] ?? '';
      awaitingFingerprint = false;
    } else if (fields[0] === 'sub') owners.set(fields[4] ?? '', primary);
  }
  return keyIds.map((id) => owners.get(id ?? '') ?? 'unknown').sort();
}
