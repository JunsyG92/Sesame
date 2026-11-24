import path from 'node:path';
import { app, BrowserWindow, screen, shell } from 'electron';
import { isIpcEvent, type IpcEvent, type IpcEventPayload } from '../../shared/ipc';
import type { ManagerTab } from '../../shared/schemas';

const PRELOAD = path.join(import.meta.dirname, '../preload/index.cjs');
const RENDERER_DIR = path.join(import.meta.dirname, '../renderer');
const DEV_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;

export const LAUNCHER_SIZE = { width: 680, height: 420 } as const;

type Page = 'launcher' | 'manager';

function pageUrl(page: Page): string {
  return DEV_URL === undefined
    ? new URL(`file://${path.join(RENDERER_DIR, page, 'index.html')}`).toString()
    : `${DEV_URL}/${page}/index.html`;
}

/** True when a frame URL is one of our own pages (used to authenticate IPC senders). */
export function isTrustedUrl(url: string): boolean {
  if (DEV_URL !== undefined && url.startsWith(`${DEV_URL}/`)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') return false;
    const file = path.normalize(decodeURIComponent(parsed.pathname));
    const normalized = process.platform === 'win32' ? file.replace(/^[\\/]+/, '') : file;
    return normalized.startsWith(RENDERER_DIR + path.sep);
  } catch {
    return false;
  }
}

const webPreferences: Electron.WebPreferences = {
  preload: PRELOAD,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  spellcheck: false,
  devTools: !app.isPackaged,
};

/** Hardening applied to every web contents ever created by the app. */
export function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault();
    });
    contents.on('will-redirect', (event) => {
      event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
    });
  });
}

export class Windows {
  private launcher: BrowserWindow | null = null;
  private manager: BrowserWindow | null = null;
  /** Number of native dialogs open: the launcher must not hide when they take focus. */
  private dialogs = 0;
  private quitting = false;

  public constructor(private readonly options: { keepOpenOnBlur: boolean }) {}

  public get launcherVisible(): boolean {
    return this.launcher?.isVisible() === true;
  }

  public setQuitting(): void {
    this.quitting = true;
  }

  private createLauncher(): BrowserWindow {
    const window = new BrowserWindow({
      ...LAUNCHER_SIZE,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      title: 'Sesame',
      webPreferences,
    });
    window.setAlwaysOnTop(true, 'pop-up-menu');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.on('blur', () => {
      if (!this.options.keepOpenOnBlur && this.dialogs === 0) this.hideLauncher();
    });
    window.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.hideLauncher();
    });
    void window.loadURL(pageUrl('launcher'));
    return window;
  }

  /** Centres the launcher on the display that currently holds the mouse cursor. */
  public showLauncher(): void {
    this.launcher ??= this.createLauncher();
    const window = this.launcher;
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    window.setBounds({
      x: Math.round(workArea.x + (workArea.width - LAUNCHER_SIZE.width) / 2),
      y: Math.round(workArea.y + (workArea.height - LAUNCHER_SIZE.height) / 3),
      ...LAUNCHER_SIZE,
    });
    window.show();
    window.focus();
    window.webContents.focus();
    this.send('launcher:shown', null);
  }

  public hideLauncher(): void {
    if (this.launcher?.isVisible() !== true) return;
    this.launcher.setContentProtection(false);
    this.launcher.hide();
    // Give the focus back to the previously active application on macOS.
    if (process.platform === 'darwin' && this.manager === null) app.hide();
  }

  public toggleLauncher(): void {
    if (this.launcherVisible) this.hideLauncher();
    else this.showLauncher();
  }

  public openManager(tab?: ManagerTab): void {
    if (this.manager !== null) {
      if (this.manager.isMinimized()) this.manager.restore();
      this.manager.show();
      this.manager.focus();
      if (tab !== undefined) this.manager.webContents.send('sesame:event:manager:navigate', tab);
      return;
    }
    const window = new BrowserWindow({
      width: 1080,
      height: 720,
      minWidth: 820,
      minHeight: 520,
      show: false,
      title: 'Sesame',
      autoHideMenuBar: true,
      webPreferences,
    });
    this.manager = window;
    window.once('ready-to-show', () => {
      window.show();
    });
    window.on('closed', () => {
      this.manager = null;
      if (process.platform === 'darwin') app.dock?.hide();
    });
    if (process.platform === 'darwin') void app.dock?.show();
    // The initial tab travels in the URL fragment (the page is not listening yet).
    void window.loadURL(tab === undefined ? pageUrl('manager') : `${pageUrl('manager')}#${tab}`);
    this.hideLauncher();
  }

  public send<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void {
    if (!isIpcEvent(event)) return;
    for (const window of [this.launcher, this.manager]) {
      if (window?.isDestroyed() === false) {
        window.webContents.send(`sesame:event:${event}`, payload);
      }
    }
  }

  /** Excludes a window from screenshots/recordings while it displays a secret. */
  public setSecretVisible(senderId: number, visible: boolean): void {
    for (const window of [this.launcher, this.manager]) {
      if (window?.isDestroyed() === false && window.webContents.id === senderId) {
        window.setContentProtection(visible);
      }
    }
  }

  /** Runs a native dialog without letting the launcher auto-hide underneath it. */
  public async withDialog<T>(run: (parent: BrowserWindow | undefined) => Promise<T>): Promise<T> {
    this.dialogs += 1;
    try {
      // File pickers are only opened from the manager window.
      return await run(this.manager ?? undefined);
    } finally {
      this.dialogs -= 1;
    }
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:' || parsed.protocol === 'http:') await shell.openExternal(url);
}
