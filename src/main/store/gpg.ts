import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { AppError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import type { GpgKey } from '../../shared/schemas';
import type { GpgKeyId, PlainSecret } from '../../shared/types';
import { asPlainSecret } from '../../shared/types';
import type { RunOutput, Runner } from '../exec';

/* ------------------------------------------------------------- detection */

export type Platform = 'linux' | 'win32' | 'darwin';
export type FileProbe = (file: string) => Promise<boolean>;

export const isExecutable: FileProbe = async (file) => {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

function standardLocations(platform: Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.ProgramW6432];
    const fallback = ['C:\\Program Files (x86)', 'C:\\Program Files'];
    return [...new Set([...roots.filter((root) => root !== undefined), ...fallback])].map((root) =>
      path.win32.join(root, 'GnuPG', 'bin', 'gpg.exe'),
    );
  }
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin/gpg',
      '/usr/local/bin/gpg',
      '/usr/local/MacGPG2/bin/gpg2',
      '/usr/local/MacGPG2/bin/gpg',
      '/opt/local/bin/gpg',
    ];
  }
  return ['/usr/bin/gpg', '/usr/local/bin/gpg', '/usr/bin/gpg2', '/bin/gpg'];
}

function pathCandidates(platform: Platform, env: NodeJS.ProcessEnv): string[] {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const variable = env.PATH ?? env.Path ?? '';
  const names = platform === 'win32' ? ['gpg.exe', 'gpg2.exe'] : ['gpg', 'gpg2'];
  return variable
    .split(api.delimiter)
    .filter((dir) => dir !== '')
    .flatMap((dir) => names.map((name) => api.join(dir, name)));
}

/**
 * Locates the gpg binary: custom path from the settings, then `PATH`, then
 * the standard install locations of each OS (GUI apps on macOS do not inherit
 * the shell `PATH`, Gpg4win is not always on `PATH`).
 */
export async function findGpg(
  platform: Platform,
  env: NodeJS.ProcessEnv,
  customPath: string | null,
  probe: FileProbe = isExecutable,
): Promise<string | null> {
  const candidates = [
    ...(customPath === null ? [] : [customPath]),
    ...pathCandidates(platform, env),
    ...standardLocations(platform, env),
  ];
  for (const candidate of candidates) {
    if (await probe(candidate)) return candidate;
  }
  return null;
}

/* --------------------------------------------------------------- parsing */

/** `PASSWORD_STORE_GPG_OPTS` is a whitespace-separated list of extra options. */
export function parseGpgOpts(env: NodeJS.ProcessEnv): string[] {
  return (env.PASSWORD_STORE_GPG_OPTS ?? '').split(/\s+/).filter((part) => part !== '');
}

const STATUS_PREFIX = '[GNUPG:] ';
const GPG_ERR_CANCELED = 99;
const GPG_ERR_FULLY_CANCELED = 198;

interface Diagnostics {
  readonly status: string[][];
  readonly message: string;
}

function splitDiagnostics(stderr: string): Diagnostics {
  const status: string[][] = [];
  const human: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (line.startsWith(STATUS_PREFIX)) status.push(line.slice(STATUS_PREFIX.length).split(' '));
    else if (line.trim() !== '') human.push(line.trim());
  }
  // Errors come last (start-up chatter first): keep the tail, not the head.
  return { status, message: human.join('\n').slice(-600) };
}

function isCancelled(status: string[][]): boolean {
  return status.some((fields) => {
    if (fields[0] !== 'ERROR' && fields[0] !== 'FAILURE') return false;
    const code = Number(fields[2]) & 0xffff;
    return code === GPG_ERR_CANCELED || code === GPG_ERR_FULLY_CANCELED;
  });
}

/** Maps a failed gpg run to a typed error using the machine-readable status lines. */
export function gpgError(output: RunOutput): AppError {
  const { status, message } = splitDiagnostics(output.stderr);
  const has = (keyword: string): boolean => status.some((fields) => fields[0] === keyword);
  if (isCancelled(status)) return { kind: 'gpg-cancelled' };
  if (has('NO_SECKEY')) return { kind: 'gpg-no-secret-key' };
  if (has('INV_RECP') || has('KEYEXPIRED') || has('KEYREVOKED')) {
    return { kind: 'gpg-key-unusable', message };
  }
  return {
    kind: 'gpg-failed',
    message: message === '' ? `gpg exited with ${String(output.code)}` : message,
  };
}

/** Colon listings escape bytes as `\xNN`; the result is UTF-8 (user ids may be non-ASCII). */
function unescapeColons(value: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < value.length;) {
    const escaped = /^\\x([0-9a-fA-F]{2})/.exec(value.slice(index, index + 4));
    if (escaped?.[1] === undefined) {
      bytes.push(...Buffer.from(value.charAt(index), 'utf8'));
      index += 1;
    } else {
      bytes.push(Number.parseInt(escaped[1], 16));
      index += 4;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

const toTimestamp = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return value === undefined || value === '' || Number.isNaN(parsed) ? null : parsed;
};

/** Parses `gpg --list-keys --with-colons` output. */
export function parseKeyListing(output: string, secretFingerprints: ReadonlySet<string>): GpgKey[] {
  const keys: GpgKey[] = [];
  let current: { -readonly [K in keyof GpgKey]: GpgKey[K] } | null = null;
  let expectPrimaryFingerprint = false;
  for (const line of output.split(/\r?\n/)) {
    const fields = line.split(':');
    const type = fields[0];
    if (type === 'pub' || type === 'sec') {
      const validity = fields[1] ?? '';
      current = {
        fingerprint: '',
        keyId: fields[4] ?? '',
        uids: [],
        canEncrypt: (fields[11] ?? '').includes('E'),
        hasSecret: type === 'sec',
        expired: validity === 'e' || validity === 'r' || validity === 'd' || validity === 'i',
        created: toTimestamp(fields[5]),
        expires: toTimestamp(fields[6]),
      };
      keys.push(current);
      expectPrimaryFingerprint = true;
    } else if (type === 'fpr' && current !== null && expectPrimaryFingerprint) {
      current.fingerprint = fields[9] ?? '';
      current.hasSecret = current.hasSecret || secretFingerprints.has(current.fingerprint);
      expectPrimaryFingerprint = false;
    } else if (type === 'uid' && current !== null) {
      current.uids.push(unescapeColons(fields[9] ?? ''));
    }
  }
  return keys.filter((key) => key.fingerprint !== '');
}

/* ----------------------------------------------------------------- class */

export interface GenerateKeyOptions {
  readonly name: string;
  readonly email: string;
  /**
   * Test hook: create the key without passphrase protection and without
   * pinentry. Never used by the application UI, where gpg-agent asks the
   * user for the new passphrase through pinentry.
   */
  readonly unprotected?: boolean;
}

export class Gpg {
  private readonly extraOpts: readonly string[];

  public constructor(
    public readonly binary: string,
    private readonly runner: Runner,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    this.extraOpts = parseGpgOpts(env);
  }

  private async run(
    args: readonly string[],
    input?: string | Buffer,
    signal?: AbortSignal,
  ): Promise<Result<RunOutput, AppError>> {
    const result = await this.runner(this.binary, {
      args,
      env: this.env,
      ...(input === undefined ? {} : { input }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) {
      return err(result.error === 'aborted' ? { kind: 'cancelled' } : { kind: 'gpg-not-found' });
    }
    if (result.value.code !== 0) return err(gpgError(result.value));
    return ok(result.value);
  }

  public async version(): Promise<Result<string, AppError>> {
    const result = await this.run(['--version']);
    if (!result.ok) return result;
    const match = /(\d+\.\d+\.\d+)/.exec(result.value.stdout.split('\n')[0] ?? '');
    return ok(match?.[1] ?? 'unknown');
  }

  /** `pass`-compatible encryption; the plaintext is only ever written to stdin. */
  public async encrypt(
    recipients: readonly GpgKeyId[],
    plaintext: PlainSecret,
    outputFile: string,
  ): Promise<Result<null, AppError>> {
    if (recipients.length === 0) return err({ kind: 'store-not-initialized' });
    const result = await this.run(
      [
        ...this.extraOpts,
        '--encrypt',
        '--batch',
        '--yes',
        '--quiet',
        '--status-fd',
        '2',
        '--compress-algo=none',
        '--no-encrypt-to',
        ...recipients.flatMap((recipient) => ['--recipient', recipient]),
        '--output',
        outputFile,
      ],
      plaintext,
    );
    return result.ok ? ok(null) : result;
  }

  /** Decrypts to stdout; the passphrase is handled by gpg-agent and pinentry. */
  public async decrypt(file: string, signal?: AbortSignal): Promise<Result<PlainSecret, AppError>> {
    const result = await this.run(
      [
        ...this.extraOpts,
        '--decrypt',
        '--batch',
        '--quiet',
        '--yes',
        '--status-fd',
        '2',
        '--',
        file,
      ],
      undefined,
      signal,
    );
    return result.ok ? ok(asPlainSecret(result.value.stdout)) : result;
  }

  public async listKeys(secretOnly: boolean): Promise<Result<GpgKey[], AppError>> {
    const base = ['--batch', '--with-colons', '--with-fingerprint'];
    const secret = await this.run([...base, '--list-secret-keys']);
    if (!secret.ok) return secret;
    const secretKeys = parseKeyListing(secret.value.stdout, new Set());
    if (secretOnly) return ok(secretKeys);
    const all = await this.run([...base, '--list-keys']);
    if (!all.ok) return all;
    return ok(parseKeyListing(all.value.stdout, new Set(secretKeys.map((key) => key.fingerprint))));
  }

  /** Creates an ed25519 (sign) + cv25519 (encrypt) key pair. */
  public async generateKey(options: GenerateKeyOptions): Promise<Result<GpgKey, AppError>> {
    const name = options.name.trim();
    const email = options.email.trim();
    if (!/^[^<>()\\\n-][^<>()\\\n]*$/.test(name) || !/^[^\s<>-][^\s<>]*@[^\s<>]+$/.test(email)) {
      return err({ kind: 'invalid-argument', message: 'invalid name or e-mail' });
    }
    const unprotected =
      options.unprotected === true ? ['--pinentry-mode', 'loopback', '--passphrase', ''] : [];
    const created = await this.run([
      '--batch',
      '--status-fd',
      '2',
      // Arguments are UTF-8 whatever the locale gpg was started with.
      '--utf8-strings',
      ...unprotected,
      '--quick-generate-key',
      `${name} <${email}>`,
      'future-default',
      'default',
      'never',
    ]);
    if (!created.ok) return created;
    const status = splitDiagnostics(created.value.stderr).status;
    const fingerprint = status.find((fields) => fields[0] === 'KEY_CREATED')?.[2];
    const keys = await this.listKeys(true);
    if (!keys.ok) return keys;
    const key = keys.value.find((candidate) => candidate.fingerprint === fingerprint);
    if (key === undefined) return err({ kind: 'gpg-failed', message: 'key was not created' });
    return ok(key);
  }

  /** Imports a public or secret key block; returns the number of keys processed. */
  public async importKey(keyData: Buffer): Promise<Result<number, AppError>> {
    const result = await this.run(['--batch', '--status-fd', '2', '--import'], keyData);
    if (!result.ok) return result;
    const summary = splitDiagnostics(result.value.stderr).status.find(
      (fields) => fields[0] === 'IMPORT_RES',
    );
    return ok(Number(summary?.[1] ?? 0));
  }

  /** `gpgconf --reload gpg-agent`: makes the agent forget cached passphrases. */
  public async reloadAgent(): Promise<Result<null, AppError>> {
    const extension = path.extname(this.binary);
    const gpgconf = path.join(path.dirname(this.binary), `gpgconf${extension}`);
    const result = await this.runner(gpgconf, { args: ['--reload', 'gpg-agent'], env: this.env });
    if (!result.ok) return err({ kind: 'gpg-not-found' });
    if (result.value.code !== 0) return err(gpgError(result.value));
    return ok(null);
  }
}
