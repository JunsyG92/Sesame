import { watch, type FSWatcher } from 'chokidar';
import { desktopCapturer, dialog, nativeImage, screen, type BrowserWindow } from 'electron';
import { bgraToRgba, type RgbaImage } from '../qr';

function toRgba(image: Electron.NativeImage): RgbaImage | null {
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  return bgraToRgba(image.toBitmap(), width, height);
}

export function loadImage(file: string): Promise<RgbaImage | null> {
  return Promise.resolve(toRgba(nativeImage.createFromPath(file)));
}

/** Grabs every screen at native resolution (to find a QR code shown on screen). */
export async function captureScreens(): Promise<RgbaImage[]> {
  const largest = screen
    .getAllDisplays()
    .map((display) => ({
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
    }))
    .reduce(
      (max, size) => ({
        width: Math.max(max.width, size.width),
        height: Math.max(max.height, size.height),
      }),
      { width: 0, height: 0 },
    );
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: largest });
    return sources.map((source) => toRgba(source.thumbnail)).filter((image) => image !== null);
  } catch {
    return [];
  }
}

type FileKind = 'image' | 'key' | 'binary';
const FILTERS: Readonly<Record<FileKind, Electron.FileFilter[]>> = {
  image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  key: [{ name: 'OpenPGP keys', extensions: ['asc', 'gpg', 'pgp', 'key', 'pub', 'txt'] }],
  binary: [],
};

export async function chooseFile(
  parent: BrowserWindow | undefined,
  kind: FileKind,
): Promise<string | null> {
  const options: Electron.OpenDialogOptions = { properties: ['openFile'], filters: FILTERS[kind] };
  const result = await (parent === undefined
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(parent, options));
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export async function chooseDirectory(parent: BrowserWindow | undefined): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory', 'showHiddenFiles'],
  };
  const result = await (parent === undefined
    ? dialog.showOpenDialog(options)
    : dialog.showOpenDialog(parent, options));
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/** Watches the store so that changes made by `pass` or `git pull` show up immediately. */
export class StoreWatcher {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  public watch(dir: string, onChange: () => void): void {
    void this.close();
    this.watcher = watch(dir, {
      ignoreInitial: true,
      ignored: (file) => /[\\/]\.git([\\/]|$)/.test(file) || file.includes('.tmp-'),
      awaitWriteFinish: false,
    });
    const schedule = (): void => {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(onChange, 200);
    };
    this.watcher.on('all', schedule).on('error', () => undefined);
  }

  public async close(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    await this.watcher?.close();
    this.watcher = null;
  }
}
