import type { ClipboardBackend } from './clipboard';
import type { Platform } from './store/gpg';

/** Subset of Electron's (asynchronous, Electron ≥ 45) `clipboard` module. */
export interface SystemClipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  clear(): void;
}

/** Writes one clipboard entry carrying several formats atomically (`clipboard.write`). */
export type MultiFormatWriter = (formats: Record<string, string | Blob>) => Promise<void>;

/** Electron's escape hatch to address a raw, platform-specific clipboard format. */
export const rawFormat = (format: string): string =>
  `electron application/osclipboard;format="${format}"`;

/**
 * Formats telling clipboard managers and clipboard history not to record the
 * copied secret:
 * - Windows: `ExcludeClipboardContentFromMonitorProcessing` (any content) and
 *   `CanIncludeInClipboardHistory` / `CanUploadToCloudClipboard` = DWORD 0;
 * - macOS: `org.nspasteboard.ConcealedType` (nspasteboard.org convention);
 * - Linux: `x-kde-passwordManagerHint` = `secret` (Klipper, CopyQ, GPaste…).
 */
export function concealmentFormats(platform: Platform): Record<string, string | Blob> {
  if (platform === 'win32') {
    const dwordZero = (): Blob => new Blob([new Uint8Array(4)]);
    return {
      [rawFormat('ExcludeClipboardContentFromMonitorProcessing')]: dwordZero(),
      [rawFormat('CanIncludeInClipboardHistory')]: dwordZero(),
      [rawFormat('CanUploadToCloudClipboard')]: dwordZero(),
    };
  }
  if (platform === 'darwin') return { [rawFormat('org.nspasteboard.ConcealedType')]: '' };
  return { [rawFormat('x-kde-passwordManagerHint')]: 'secret' };
}

/**
 * Copies secrets together with the concealment hints of the platform. If the
 * platform refuses the extra formats, falls back to a plain-text copy: the
 * secret is still cleared after the timeout, it is just not hidden from
 * clipboard history tools.
 */
export function createClipboardBackend(
  platform: Platform,
  clipboard: SystemClipboard,
  writeFormats: MultiFormatWriter,
): ClipboardBackend {
  return {
    readText: () => clipboard.readText(),
    clear: () => {
      clipboard.clear();
    },
    async writeSecret(text) {
      if (text === '') {
        clipboard.clear();
        return;
      }
      try {
        await writeFormats({ 'text/plain': text, ...concealmentFormats(platform) });
        if ((await clipboard.readText()) === text) return;
      } catch {
        // fall through to the plain copy
      }
      await clipboard.writeText(text);
    },
  };
}
