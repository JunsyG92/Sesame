import path from 'node:path';
import { SecureClipboard, type ClipboardBackend } from '../../src/main/clipboard';
import { rejectionSampler } from '../../src/main/generator';
import type { RgbaImage } from '../../src/main/qr';
import { Services, type Ports } from '../../src/main/services';
import { defaultSettings, SettingsStore, UsageHistoryStore } from '../../src/main/settings';
import type {
  IpcChannel,
  IpcEvent,
  IpcEventPayload,
  IpcInput,
  IpcResult,
} from '../../src/shared/ipc';
import type { Platform } from '../../src/main/store/gpg';
import type { Sandbox } from './gpgEnv';

/** The real platform: gpg detection must follow the OS the tests run on. */
export const hostPlatform: Platform =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';

export class MemoryClipboard implements ClipboardBackend {
  public content = '';
  public readText(): Promise<string> {
    return Promise.resolve(this.content);
  }
  public writeSecret(text: string): Promise<void> {
    this.content = text;
    return Promise.resolve();
  }
  public clear(): void {
    this.content = '';
  }
}

export interface Harness {
  readonly services: Services;
  readonly clipboard: MemoryClipboard;
  readonly events: { event: IpcEvent; payload: unknown }[];
  readonly opened: string[];
  readonly calls: string[];
  readonly settings: SettingsStore;
  readonly history: UsageHistoryStore;
  now: number;
  chosenFile: string | null;
  chosenDirectory: string | null;
  screens: RgbaImage[];
  image: RgbaImage | null;
  shortcutAccepted: boolean;
  call<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcResult<C>>;
  last<E extends IpcEvent>(event: E): IpcEventPayload<E> | undefined;
}

/** A `Services` instance wired to fakes for every Electron/OS port. */
export async function createHarness(
  sandbox: Sandbox,
  overrides: Partial<Ports> = {},
): Promise<Harness> {
  const clipboard = new MemoryClipboard();
  const settings = new SettingsStore(path.join(sandbox.root, 'settings.json'), {
    ...defaultSettings(sandbox.env, 'linux'),
    storeDir: sandbox.storeDir,
  });
  await settings.load();
  const history = new UsageHistoryStore(path.join(sandbox.root, 'history.json'), () => harness.now);
  let counter = 0;
  let services: Services | null = null;
  const harness: Harness = {
    get services(): Services {
      if (services === null) throw new Error('harness not ready');
      return services;
    },
    clipboard,
    events: [],
    opened: [],
    calls: [],
    settings,
    history,
    now: 59_000,
    chosenFile: null,
    chosenDirectory: null,
    screens: [],
    image: null,
    shortcutAccepted: true,
    call: (channel, input) => harness.services.handlers[channel](input, { senderId: 7 }),
    last: (event) => {
      const found = harness.events.filter((item) => item.event === event).at(-1);
      // Test helper: events are recorded with the payload type of their channel.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      return found?.payload as IpcEventPayload<typeof event> | undefined;
    },
  };
  const ports: Ports = {
    platform: hostPlatform,
    env: sandbox.env,
    home: sandbox.root,
    version: '1.2.3',
    systemLocale: 'fr-FR',
    wayland: false,
    runner: sandbox.runner,
    probe: (file) =>
      import('../../src/main/store/gpg').then(({ isExecutable }) => isExecutable(file)),
    settings,
    history,
    clipboard: new SecureClipboard(clipboard),
    rng: rejectionSampler(() => (counter = (counter * 1103515245 + 12345) >>> 0)),
    now: () => harness.now,
    readClipboard: () => Promise.resolve(clipboard.content),
    emit: (event, payload) => harness.events.push({ event, payload }),
    openExternal: (url) => {
      harness.opened.push(url);
      return Promise.resolve();
    },
    chooseDirectory: () => Promise.resolve(harness.chosenDirectory),
    chooseFile: () => Promise.resolve(harness.chosenFile),
    loadImage: () => Promise.resolve(harness.image),
    captureScreens: () => Promise.resolve(harness.screens),
    applyShortcut: () => harness.shortcutAccepted,
    shortcutStatus: () => ({ accelerator: settings.value.shortcut, registered: true }),
    setAutoStart: (enabled) => {
      harness.calls.push(`autostart:${String(enabled)}`);
      return Promise.resolve();
    },
    openManager: () => harness.calls.push('openManager'),
    hideLauncher: () => harness.calls.push('hideLauncher'),
    quit: () => harness.calls.push('quit'),
    setSecretVisible: (sender, visible) =>
      harness.calls.push(`secret:${String(sender)}:${String(visible)}`),
    watchStore: (dir) => harness.calls.push(`watch:${dir}`),
    ...overrides,
  };
  services = new Services(ports);
  await harness.services.refresh();
  return harness;
}
