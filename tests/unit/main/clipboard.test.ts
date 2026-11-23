import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveClipTime,
  SecureClipboard,
  type ClipboardBackend,
} from '../../../src/main/clipboard';
import { asPlainSecret } from '../../../src/shared/types';

class FakeClipboard implements ClipboardBackend {
  public content = '';
  public cleared = 0;
  public readText(): string {
    return this.content;
  }
  public writeSecret(text: string): Promise<void> {
    this.content = text;
    return Promise.resolve();
  }
  public clear(): void {
    this.content = '';
    this.cleared += 1;
  }
}

describe('SecureClipboard', () => {
  let backend: FakeClipboard;
  let countdown: number[];
  let clipboard: SecureClipboard;

  beforeEach(() => {
    vi.useFakeTimers();
    backend = new FakeClipboard();
    countdown = [];
    clipboard = new SecureClipboard(backend, (remaining) => countdown.push(remaining));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies, counts down and clears after the delay', async () => {
    await clipboard.copy(asPlainSecret('s3cret'), 3);
    expect(backend.content).toBe('s3cret');
    expect(clipboard.secondsRemaining).toBe(3);
    vi.advanceTimersByTime(2000);
    expect(backend.content).toBe('s3cret');
    expect(clipboard.secondsRemaining).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(backend.content).toBe('');
    expect(backend.cleared).toBe(1);
    expect(countdown).toEqual([3, 2, 1, 0]);
    vi.advanceTimersByTime(10_000);
    expect(backend.cleared).toBe(1);
  });

  it('does not clear a clipboard that changed in the meantime', async () => {
    await clipboard.copy(asPlainSecret('s3cret'), 2);
    backend.content = 'something the user copied';
    vi.advanceTimersByTime(2000);
    expect(backend.content).toBe('something the user copied');
    expect(backend.cleared).toBe(0);
    expect(countdown.at(-1)).toBe(0);
  });

  it('restarts the countdown when another secret is copied', async () => {
    await clipboard.copy(asPlainSecret('first'), 2);
    vi.advanceTimersByTime(1000);
    await clipboard.copy(asPlainSecret('second'), 2);
    vi.advanceTimersByTime(1000);
    expect(backend.content).toBe('second');
    vi.advanceTimersByTime(1000);
    expect(backend.content).toBe('');
    expect(backend.cleared).toBe(1);
  });

  it('clearNow clears immediately and is idempotent', async () => {
    clipboard.clearNow();
    expect(backend.cleared).toBe(0);
    await clipboard.copy(asPlainSecret('s3cret'), 45);
    clipboard.clearNow();
    expect(backend.content).toBe('');
    expect(clipboard.secondsRemaining).toBe(0);
    clipboard.clearNow();
    expect(backend.cleared).toBe(1);
  });

  it('never waits less than a second and works without a listener', async () => {
    const silent = new SecureClipboard(backend);
    await silent.copy(asPlainSecret('x'), 0);
    expect(silent.secondsRemaining).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(backend.content).toBe('');
  });
});

describe('resolveClipTime', () => {
  it('follows settings, then PASSWORD_STORE_CLIP_TIME, then 45 seconds', () => {
    expect(resolveClipTime(10, { PASSWORD_STORE_CLIP_TIME: '90' })).toBe(10);
    expect(resolveClipTime(null, { PASSWORD_STORE_CLIP_TIME: '90' })).toBe(90);
    expect(resolveClipTime(null, { PASSWORD_STORE_CLIP_TIME: 'soon' })).toBe(45);
    expect(resolveClipTime(null, { PASSWORD_STORE_CLIP_TIME: '0' })).toBe(45);
    expect(resolveClipTime(null, {})).toBe(45);
  });
});
