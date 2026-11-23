import os from 'node:os';
import path from 'node:path';
import {
  app,
  clipboard,
  ClipboardItem,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  session,
  Tray,
} from 'electron';
import electronUpdater from 'electron-updater';
import { formatAccelerator } from '../shared/accelerator';
import { mainStrings } from '../shared/i18n/main';
import { setLinuxAutostart } from './autostart';
import {
  captureScreens,
  chooseDirectory,
  chooseFile,
  loadImage,
  StoreWatcher,
} from './app/platform';
import { hardenWebContents, isTrustedUrl, openExternalUrl, Windows } from './app/windows';
import { SecureClipboard } from './clipboard';
import { createClipboardBackend } from './clipboardBackend';
import { runProcess } from './exec';
import { dispatch } from './ipc';
import { resolveLocale, Services } from './services';
import { defaultSettings, SettingsStore, UsageHistoryStore } from './settings';
import { parseCliAction, ShortcutManager, type CliAction } from './shortcuts';
import { isExecutable, type Platform } from './store/gpg';

const platform: Platform =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
const wayland =
  platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || (process.env.WAYLAND_DISPLAY ?? '') !== '');
const e2e = process.env.SESAME_E2E === '1';

// An isolated profile for tests and portable setups.
const customUserData = process.env.SESAME_USER_DATA;
if (customUserData !== undefined && customUserData !== '') app.setPath('userData', customUserData);

app.enableSandbox();
if (platform === 'linux') {
  // Lets `globalShortcut` go through org.freedesktop.portal.GlobalShortcuts on Wayland.
  app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
}

const firstAction = parseCliAction(process.argv);

if (!app.requestSingleInstanceLock()) {
  // A running instance receives our argv through `second-instance` (e.g. `--toggle`).
  app.quit();
} else {
  void start();
}

async function start(): Promise<void> {
  hardenWebContents();
  const windows = new Windows({ keepOpenOnBlur: e2e });
  let tray: Tray | null = null;
  let services: Services | null = null;
  let strings = mainStrings.en;

  const perform = (action: CliAction | null): void => {
    if (action === 'toggle') windows.toggleLauncher();
    else if (action === 'manager') windows.openManager();
    else if (action !== 'hidden') windows.showLauncher();
  };
  app.on('second-instance', (_event, argv) => {
    perform(parseCliAction(argv));
  });
  // The app lives in the tray: closing every window must not quit it.
  app.on('window-all-closed', () => undefined);
  app.on('before-quit', () => {
    windows.setQuitting();
    services?.stopAutoLock();
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  await app.whenReady();
  if (platform === 'darwin') app.dock?.hide();

  // No remote content, no permissions: the UI is entirely local.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  const userData = app.getPath('userData');
  const settings = new SettingsStore(
    path.join(userData, 'settings.json'),
    defaultSettings(process.env, platform),
  );
  const history = new UsageHistoryStore(path.join(userData, 'history.json'));
  await settings.load();
  await history.load();
  strings = mainStrings[resolveLocale(settings.value.language, app.getLocale())];

  const updateTray = (remaining: number): void => {
    if (tray === null) return;
    const shortcut = formatAccelerator(shortcuts.status.accelerator, platform === 'darwin');
    tray.setToolTip(remaining > 0 ? strings.clearingIn(remaining) : `Sesame — ${shortcut}`);
    if (platform === 'darwin') tray.setTitle(remaining > 0 ? `${String(remaining)}s` : '');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: strings.openLauncher,
          click: () => {
            windows.showLauncher();
          },
        },
        {
          label: strings.openManager,
          click: () => {
            windows.openManager();
          },
        },
        { type: 'separator' },
        {
          label: remaining > 0 ? strings.clearNow(remaining) : strings.clipboardEmpty,
          enabled: remaining > 0,
          click: () => {
            void secureClipboard.clearNow();
          },
        },
        {
          label: strings.lockNow,
          click: () => {
            void services?.lock();
          },
        },
        { type: 'separator' },
        {
          label: strings.quit,
          click: () => {
            app.quit();
          },
        },
      ]),
    );
  };

  const secureClipboard = new SecureClipboard(
    createClipboardBackend(platform, clipboard, (formats) =>
      clipboard.write([new ClipboardItem(formats)]),
    ),
    (remaining) => {
      updateTray(remaining);
      windows.send('clipboard:countdown', { remaining });
    },
  );
  const shortcuts = new ShortcutManager(globalShortcut, () => {
    windows.toggleLauncher();
  });
  const watcher = new StoreWatcher();

  services = new Services({
    platform,
    env: process.env,
    home: os.homedir(),
    version: app.getVersion(),
    systemLocale: app.getLocale(),
    wayland,
    runner: runProcess,
    probe: isExecutable,
    settings,
    history,
    clipboard: secureClipboard,
    now: () => Date.now(),
    readClipboard: () => clipboard.readText(),
    emit: (event, payload) => {
      if (event === 'settings:changed') {
        strings = mainStrings[resolveLocale(settings.value.language, app.getLocale())];
        updateTray(secureClipboard.secondsRemaining);
      }
      windows.send(event, payload);
    },
    openExternal: openExternalUrl,
    chooseDirectory: () => windows.withDialog((parent) => chooseDirectory(parent)),
    chooseFile: (kind) => windows.withDialog((parent) => chooseFile(parent, kind)),
    loadImage,
    captureScreens,
    applyShortcut: (accelerator) => shortcuts.apply(accelerator),
    shortcutStatus: () => shortcuts.status,
    setAutoStart: async (enabled) => {
      if (platform === 'linux') {
        await setLinuxAutostart(enabled, process.env, os.homedir(), process.execPath);
      } else {
        app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
      }
    },
    openManager: () => {
      windows.openManager();
    },
    hideLauncher: () => {
      windows.hideLauncher();
    },
    quit: () => {
      app.quit();
    },
    setSecretVisible: (senderId, visible) => {
      windows.setSecretVisible(senderId, visible);
    },
    watchStore: (dir, onChange) => {
      watcher.watch(dir, onChange);
    },
  });
  const { handlers } = services;
  const activeServices = services;

  ipcMain.handle('sesame:invoke', (event, channel: unknown, input: unknown) => {
    // Only our own pages, in the top-level frame, may talk to the main process.
    const frame = event.senderFrame;
    if (frame?.parent !== null || !isTrustedUrl(frame.url)) {
      return { ok: false, error: { kind: 'invalid-argument', message: 'untrusted sender' } };
    }
    activeServices.touch();
    return dispatch(handlers, typeof channel === 'string' ? channel : '', input, {
      senderId: event.sender.id,
    });
  });

  shortcuts.apply(settings.value.shortcut);
  await services.refresh();
  services.startAutoLock();

  const trayIcon = (): Electron.NativeImage => {
    const file =
      platform === 'darwin' ? 'trayTemplate.png' : platform === 'win32' ? 'tray.png' : 'tray.png';
    const image = nativeImage.createFromPath(
      path.join(import.meta.dirname, '../../resources', file),
    );
    if (platform === 'darwin') image.setTemplateImage(true);
    return image;
  };
  try {
    tray = new Tray(trayIcon());
    tray.on('click', () => {
      windows.toggleLauncher();
    });
    updateTray(0);
  } catch {
    // Some Linux desktops have no status notifier host: the app stays usable
    // through the global shortcut and `sesame --toggle`.
    tray = null;
  }

  if (app.isPackaged && settings.value.autoUpdate && !e2e) {
    // Updates are downloaded from the GitHub release feed and applied on quit.
    electronUpdater.autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
  }

  const status = await services.status();
  const needsSetup = status.gpg.path === null || !status.store.initialized;
  if (needsSetup && firstAction !== 'hidden') windows.openManager();
  else perform(firstAction);
}
