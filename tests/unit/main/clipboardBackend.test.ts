import { describe, expect, it } from 'vitest';
import {
  concealmentFormats,
  createClipboardBackend,
  rawFormat,
  type SystemClipboard,
} from '../../../src/main/clipboardBackend';

class FakeSystemClipboard implements SystemClipboard {
  public text = '';
  public formats: Record<string, string | Blob> = {};
  public plainWrites = 0;
  public readText(): Promise<string> {
    return Promise.resolve(this.text);
  }
  public writeText(text: string): Promise<void> {
    this.text = text;
    this.formats = { 'text/plain': text };
    this.plainWrites += 1;
    return Promise.resolve();
  }
  public clear(): void {
    this.text = '';
    this.formats = {};
  }
}

describe('concealmentFormats', () => {
  it('uses the conventions honoured by clipboard managers on each OS', async () => {
    expect(concealmentFormats('linux')).toEqual({
      [rawFormat('x-kde-passwordManagerHint')]: 'secret',
    });
    expect(concealmentFormats('darwin')).toEqual({
      [rawFormat('org.nspasteboard.ConcealedType')]: '',
    });
    const windows = concealmentFormats('win32');
    expect(Object.keys(windows).sort()).toEqual(
      [
        'CanIncludeInClipboardHistory',
        'CanUploadToCloudClipboard',
        'ExcludeClipboardContentFromMonitorProcessing',
      ].map(rawFormat),
    );
    for (const value of Object.values(windows)) {
      expect(value).toBeInstanceOf(Blob);
      if (value instanceof Blob) {
        expect([...new Uint8Array(await value.arrayBuffer())]).toEqual([0, 0, 0, 0]);
      }
    }
    expect(rawFormat('x')).toBe('electron application/osclipboard;format="x"');
  });
});

describe('createClipboardBackend', () => {
  it('writes the secret with the concealment hints in one atomic write', async () => {
    const system = new FakeSystemClipboard();
    const backend = createClipboardBackend('linux', system, (formats) => {
      system.formats = formats;
      const text = formats['text/plain'];
      system.text = typeof text === 'string' ? text : '';
      return Promise.resolve();
    });
    await backend.writeSecret('hunter2');
    expect(system.formats).toEqual({
      'text/plain': 'hunter2',
      [rawFormat('x-kde-passwordManagerHint')]: 'secret',
    });
    expect(system.plainWrites).toBe(0);
    expect(await backend.readText()).toBe('hunter2');
    backend.clear();
    expect(system.text).toBe('');
  });

  it('falls back to plain text when the platform refuses the extra formats', async () => {
    const system = new FakeSystemClipboard();
    const rejecting = createClipboardBackend('win32', system, () =>
      Promise.reject(new Error('unsupported format')),
    );
    await rejecting.writeSecret('hunter2');
    expect(system.text).toBe('hunter2');
    expect(system.plainWrites).toBe(1);

    const silent = createClipboardBackend('darwin', system, () => Promise.resolve());
    system.text = '';
    await silent.writeSecret('other');
    expect(system.text).toBe('other');
    expect(system.plainWrites).toBe(2);
  });

  it('clears instead of copying an empty secret', async () => {
    const system = new FakeSystemClipboard();
    system.text = 'previous';
    const backend = createClipboardBackend('linux', system, () => Promise.reject(new Error()));
    await backend.writeSecret('');
    expect(system.text).toBe('');
    expect(system.plainWrites).toBe(0);
  });
});
