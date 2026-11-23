import { createHash } from 'node:crypto';
import type { PlainSecret } from '../shared/types';

/** What `SecureClipboard` needs from the platform. */
export interface ClipboardBackend {
  readText(): Promise<string>;
  /** Writes text flagged as sensitive for clipboard managers/history. */
  writeSecret(text: string): Promise<void>;
  clear(): void;
}

export type CountdownListener = (remainingSeconds: number) => void;

const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Copies secrets and clears them after a delay, like `pass --clip`. The
 * clipboard is only cleared if it still holds what we put there; only a hash
 * of the copied value is kept in memory to make that check.
 */
export class SecureClipboard {
  private timer: ReturnType<typeof setInterval> | null = null;
  private copiedDigest: string | null = null;
  private remaining = 0;

  public constructor(
    private readonly backend: ClipboardBackend,
    private readonly onCountdown: CountdownListener = () => undefined,
  ) {}

  public get secondsRemaining(): number {
    return this.remaining;
  }

  public async copy(secret: PlainSecret, clearAfterSeconds: number): Promise<void> {
    this.stopTimer();
    await this.backend.writeSecret(secret);
    this.copiedDigest = digest(secret);
    this.remaining = Math.max(1, Math.floor(clearAfterSeconds));
    this.onCountdown(this.remaining);
    this.timer = setInterval(() => {
      this.remaining -= 1;
      if (this.remaining <= 0) void this.clearNow();
      else this.onCountdown(this.remaining);
    }, 1000);
  }

  /** Clears the clipboard immediately, but only if it still holds our secret. */
  public async clearNow(): Promise<void> {
    const expected = this.copiedDigest;
    this.stopTimer();
    if (expected === null) return;
    this.onCountdown(0);
    let current: string;
    try {
      current = await this.backend.readText();
    } catch {
      return;
    }
    if (digest(current) === expected) this.backend.clear();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.copiedDigest = null;
    this.remaining = 0;
  }
}

/** `PASSWORD_STORE_CLIP_TIME` (seconds, 45 by default), unless overridden in settings. */
export function resolveClipTime(setting: number | null, env: NodeJS.ProcessEnv): number {
  if (setting !== null) return setting;
  const fromEnv = Number.parseInt(env.PASSWORD_STORE_CLIP_TIME ?? '', 10);
  return Number.isNaN(fromEnv) || fromEnv < 1 ? 45 : fromEnv;
}
