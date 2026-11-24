import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { vi } from 'vitest';
import type { AppError } from '../../../src/shared/errors';
import type {
  IpcArgs,
  IpcChannel,
  IpcEvent,
  IpcEventPayload,
  IpcInput,
  IpcOutput,
  IpcResult,
  SesameApi,
} from '../../../src/shared/ipc';
import type { AppStatus, EntryView, Settings } from '../../../src/shared/schemas';
import { createI18n } from '../../../src/renderer/i18n';
import { ApiProvider } from '../../../src/renderer/lib/api';

type Handler<C extends IpcChannel> = (input: IpcInput<C>) => IpcResult<C> | Promise<IpcResult<C>>;
type HandlerMap = { [C in IpcChannel]?: Handler<C> };

export const SETTINGS: Settings = {
  shortcut: 'Control+Shift+Space',
  storeDir: null,
  gpgPath: null,
  clipTime: null,
  generator: {
    mode: 'chars',
    length: 25,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: false,
    exclude: '',
  },
  presets: [],
  autoStart: false,
  theme: 'system',
  language: 'system',
  autoLockMinutes: 15,
  reloadAgentOnLock: false,
  autoUpdate: true,
  rotationNotifications: true,
  rotationWarningDays: 7,
};

export const NO_ROTATION: EntryView['rotation'] = {
  interval: null,
  changedAt: null,
  changeUrl: null,
  status: null,
};

export const STATUS: AppStatus = {
  platform: 'linux',
  wayland: false,
  version: '0.1.0',
  locale: 'en',
  gpg: { path: '/usr/bin/gpg', version: '2.4.4' },
  store: { dir: '/home/me/.password-store', exists: true, initialized: true, isGit: true },
  shortcut: { accelerator: 'Control+Shift+Space', registered: true },
};

export const ok = <T,>(value: T): { ok: true; value: T } => ({ ok: true, value });
export const fail = (error: AppError): { ok: false; error: AppError } => ({ ok: false, error });

/** In-memory `window.sesame` for component tests. */
export class FakeApi implements SesameApi {
  public readonly calls: { channel: IpcChannel; input: unknown }[] = [];
  private readonly listeners = new Map<IpcEvent, Set<(payload: unknown) => void>>();
  public handlers: HandlerMap = {};
  public readonly invokeSpy = vi.fn();

  public constructor(handlers: HandlerMap = {}) {
    this.handlers = {
      'store:list': () => ok({ entries: [], folders: [] }),
      'history:get': () => ok({}),
      'settings:get': () => ok(SETTINGS),
      'app:status': () => ok(STATUS),
      'app:hideLauncher': () => ok(null),
      'app:secretVisible': () => ok(null),
      'clipboard:peek': () => ok({ length: 0, text: null }),
      ...handlers,
    };
  }

  public async invoke<C extends IpcChannel>(
    channel: C,
    ...args: IpcArgs<C>
  ): Promise<IpcResult<C>> {
    const input = args[0];
    this.calls.push({ channel, input });
    this.invokeSpy(channel, input);
    const handler = this.handlers[channel];
    if (handler === undefined)
      return fail({ kind: 'unexpected', message: `no fake for ${channel}` });
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: payloads are recorded per channel/event, so the type is the one of the key
    return handler(input as IpcInput<C>);
  }

  public on<E extends IpcEvent>(
    event: E,
    listener: (payload: IpcEventPayload<E>) => void,
  ): () => void {
    const set = this.listeners.get(event) ?? new Set();
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: payloads are recorded per channel/event, so the type is the one of the key
    const wrapped = listener as (payload: unknown) => void;
    set.add(wrapped);
    this.listeners.set(event, set);
    return () => {
      set.delete(wrapped);
    };
  }

  public emit<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  public callsTo<C extends IpcChannel>(channel: C): IpcInput<C>[] {
    return (
      this.calls
        .filter((call) => call.channel === channel)
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: payloads are recorded per channel/event, so the type is the one of the key
        .map((call) => call.input as IpcInput<C>)
    );
  }
}

export type { IpcOutput };

export function renderWith(api: FakeApi, ui: ReactNode, locale: 'en' | 'fr' = 'en'): RenderResult {
  return render(
    <ApiProvider api={api}>
      <I18nextProvider i18n={createI18n(locale)}>{ui}</I18nextProvider>
    </ApiProvider>,
  );
}
