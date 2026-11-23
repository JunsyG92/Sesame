import { spawn } from 'node:child_process';
import { err, ok, type Result } from '../shared/result';

/**
 * The only place where child processes are started. Programs are always run
 * with an argument array and never through a shell; secrets travel on
 * stdin/stdout only.
 */
export interface RunOptions {
  readonly args: readonly string[];
  readonly input?: string | Buffer;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface RunOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunFailure = 'not-found' | 'aborted';
export type Runner = (file: string, options: RunOptions) => Promise<Result<RunOutput, RunFailure>>;

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export const runProcess: Runner = (file, options) =>
  new Promise((resolve) => {
    if (options.signal?.aborted === true) {
      resolve(err('aborted'));
      return;
    }
    const child = spawn(file, [...options.args], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const settle = (result: Result<RunOutput, RunFailure>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      if (isNotFound(error)) settle(err('not-found'));
      else if (error.name === 'AbortError') settle(err('aborted'));
      else settle(ok({ code: null, stdout: '', stderr: error.message }));
    });
    child.on('close', (code) => {
      settle(
        ok({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      );
    });
    // A process that exits before reading its input must not crash us (EPIPE).
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
