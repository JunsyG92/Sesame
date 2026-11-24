import { readdir, readFile, stat } from 'node:fs/promises';
import type { AppError } from '../shared/errors';
import type { IpcChannel, IpcEvent, IpcEventPayload, IpcInput, IpcResult } from '../shared/ipc';
import { err, ok, type Result } from '../shared/result';
import { mainStrings } from '../shared/i18n/main';
import {
  CHANGED_KEY,
  CHANGE_URL_KEY,
  ROTATION_KEY,
  parseInterval,
  rotationStatus,
  today,
} from '../shared/rotation';
import type {
  AppStatus,
  CopyOutcome,
  EntryView,
  Locale,
  ManagerTab,
  RotationItem,
  Settings,
} from '../shared/schemas';
import { asPlainSecret, EntryPathSchema, type EntryPath, type PlainSecret } from '../shared/types';
import { resolveClipTime, type SecureClipboard } from './clipboard';
import type { Runner } from './exec';
import {
  charsetOverrideFromEnv,
  cryptoRandom,
  generatePassword,
  type RandomSource,
} from './generator';
import { decodeQr, qrDataUrl, type RgbaImage } from './qr';
import {
  resolveStoreDir,
  type RotationIndexStore,
  type RotationRecord,
  type SettingsStore,
  type UsageHistoryStore,
} from './settings';
import type { ShortcutStatus } from './shortcuts';
import {
  isValidOtpUri,
  lineOf,
  loginFor,
  parseEntry,
  replaceFirstLine,
  safeHttpUrl,
  setField,
  setOtpUri,
  totpCode,
  touchPasswordChanged,
} from './store/entry';
import { Git } from './store/git';
import { findGpg, Gpg, type FileProbe, type Platform } from './store/gpg';
import { PasswordStore } from './store/PasswordStore';
import { passwordScore } from './strength';

/** Everything the services need from Electron and the OS, as injectable ports. */
export interface Ports {
  readonly platform: Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly version: string;
  readonly systemLocale: string;
  readonly wayland: boolean;
  readonly runner: Runner;
  readonly probe: FileProbe;
  readonly settings: SettingsStore;
  readonly history: UsageHistoryStore;
  readonly rotationIndex: RotationIndexStore;
  readonly clipboard: SecureClipboard;
  readonly rng?: RandomSource;
  now(): number;
  readClipboard(): Promise<string>;
  emit<E extends IpcEvent>(event: E, payload: IpcEventPayload<E>): void;
  openExternal(url: string): Promise<void>;
  chooseDirectory(): Promise<string | null>;
  chooseFile(kind: 'image' | 'key' | 'binary'): Promise<string | null>;
  loadImage(file: string): Promise<RgbaImage | null>;
  captureScreens(): Promise<RgbaImage[]>;
  applyShortcut(accelerator: string): boolean;
  shortcutStatus(): ShortcutStatus;
  setAutoStart(enabled: boolean): Promise<void>;
  openManager(tab?: ManagerTab): void;
  /** Shows a system notification; `onClick` runs when the user clicks it. */
  notify(title: string, body: string, onClick: () => void): void;
  hideLauncher(): void;
  quit(): void;
  setSecretVisible(senderId: number, visible: boolean): void;
  watchStore(dir: string, onChange: () => void): void;
}

export interface CallContext {
  readonly senderId: number;
}

type Async<T> = Promise<Result<T, AppError>>;
export type Handlers = {
  [C in IpcChannel]: (input: IpcInput<C>, context: CallContext) => Promise<IpcResult<C>>;
};

const MAX_KEY_FILE_BYTES = 1024 * 1024;
const DONE = ok(null);

export function resolveLocale(language: Settings['language'], systemLocale: string): Locale {
  if (language !== 'system') return language;
  return systemLocale.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/**
 * Application logic behind every IPC channel. It has no dependency on
 * Electron: windows, dialogs, clipboard and shortcuts come in through `Ports`.
 */
export class Services {
  private gpg: Gpg | null = null;
  private gpgVersion: string | null = null;
  private store: PasswordStore | null = null;
  private readonly git: Git;
  private readonly jobs = new Map<string, AbortController>();
  private lastActivity: number;
  private lockTimer: ReturnType<typeof setInterval> | null = null;
  private locked = true;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;
  /** Day and set of entries last notified, so the same reminder is shown once a day. */
  private lastRotationNotice = '';

  public constructor(private readonly ports: Ports) {
    this.git = new Git(ports.runner, ports.env);
    this.lastActivity = ports.now();
  }

  /* --------------------------------------------------------- lifecycle */

  private get settings(): Settings {
    return this.ports.settings.value;
  }

  private get storeDir(): string {
    return resolveStoreDir(this.settings, this.ports.env, this.ports.home);
  }

  /** (Re)detects gpg and rebuilds the store after start-up or a settings change. */
  public async refresh(): Promise<void> {
    const binary = await findGpg(
      this.ports.platform,
      this.ports.env,
      this.settings.gpgPath,
      this.ports.probe,
    );
    this.gpg = binary === null ? null : new Gpg(binary, this.ports.runner, this.ports.env);
    const version = await this.gpg?.version();
    this.gpgVersion = version?.ok === true ? version.value : null;
    if (version?.ok === false) this.gpg = null;
    this.store =
      this.gpg === null
        ? null
        : new PasswordStore(this.storeDir, this.gpg, this.git, this.ports.env);
    this.ports.watchStore(this.storeDir, () => {
      void this.publishListing();
    });
    await this.publishStatus();
    await this.publishListing();
  }

  public async status(): Promise<AppStatus> {
    const dir = this.storeDir;
    const probe =
      this.store ?? new PasswordStore(dir, new Gpg('gpg', this.ports.runner, {}), this.git, {});
    return {
      platform: this.ports.platform,
      wayland: this.ports.wayland,
      version: this.ports.version,
      locale: resolveLocale(this.settings.language, this.ports.systemLocale),
      gpg: { path: this.gpg?.binary ?? null, version: this.gpgVersion },
      store: {
        dir,
        exists: await probe.exists(),
        initialized: await probe.isInitialized(),
        isGit: await probe.isGitRepo(),
      },
      shortcut: this.ports.shortcutStatus(),
    };
  }

  private async publishStatus(): Promise<void> {
    this.ports.emit('status:changed', await this.status());
  }

  private async publishListing(): Promise<void> {
    const listing = await this.store?.list();
    this.ports.emit(
      'store:changed',
      listing?.ok === true ? listing.value : { entries: [], folders: [] },
    );
    // Entries removed (here, with `pass` or by a git pull) leave the rotation index.
    if (listing?.ok === true && (await this.ports.rotationIndex.prune(listing.value.entries))) {
      this.publishRotation();
    }
  }

  /* ------------------------------------------------------------ rotation */

  /** Rotated entries with their deadline, most urgent first. Nothing is decrypted. */
  public rotationList(): RotationItem[] {
    const now = this.ports.now();
    const items: RotationItem[] = [];
    for (const [name, record] of Object.entries(this.ports.rotationIndex.value)) {
      const interval = parseInterval(record.interval);
      const path = EntryPathSchema.safeParse(name);
      if (interval === null || !path.success) continue;
      const status = rotationStatus(
        interval,
        record.changedAt,
        now,
        this.settings.rotationWarningDays,
      );
      items.push({
        path: path.data,
        interval: record.interval,
        changedAt: record.changedAt,
        ...status,
      });
    }
    const urgency = (item: RotationItem): number => item.daysLeft ?? Number.NEGATIVE_INFINITY;
    return items.sort((a, b) => urgency(a) - urgency(b) || a.path.localeCompare(b.path));
  }

  private publishRotation(): void {
    this.ports.emit('rotation:changed', this.rotationList());
    this.checkRotation();
  }

  /** Updates the index from decrypted content; returns whether it changed. */
  private async track(path: EntryPath, raw: string, publish = true): Promise<boolean> {
    const { interval, changedAt } = parseEntry(raw).rotation;
    const record: RotationRecord | null =
      interval !== null && parseInterval(interval) !== null ? { interval, changedAt } : null;
    const changed = await this.ports.rotationIndex.set(path, record);
    if (changed && publish) this.publishRotation();
    return changed;
  }

  /**
   * Notifies about expired (and soon expiring) passwords. The same reminder is
   * shown at most once a day; a new expiry triggers a new notification.
   */
  public checkRotation(): void {
    if (!this.settings.rotationNotifications) return;
    const due = this.rotationList().filter((item) => item.state !== 'ok');
    if (due.length === 0) {
      this.lastRotationNotice = '';
      return;
    }
    const signature = `${today(this.ports.now())}|${due.map((item) => `${item.path}:${item.state}`).join(',')}`;
    if (signature === this.lastRotationNotice) return;
    this.lastRotationNotice = signature;
    const strings = mainStrings[resolveLocale(this.settings.language, this.ports.systemLocale)];
    const expired = due.filter((item) => item.state === 'expired');
    const names = (expired.length > 0 ? expired : due).map((item) => item.path);
    const listed = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '');
    this.ports.notify(
      expired.length > 0
        ? strings.rotationExpired(expired.length)
        : strings.rotationSoon(due.length),
      `${listed}\n${strings.rotationAction}`,
      () => {
        this.ports.openManager('rotation');
      },
    );
  }

  /** Dates move on even when nothing happens: re-check regularly. */
  public startRotationMonitor(everyMs = 3_600_000): void {
    this.stopRotationMonitor();
    this.checkRotation();
    this.rotationTimer = setInterval(() => {
      this.checkRotation();
    }, everyMs);
  }

  public stopRotationMonitor(): void {
    if (this.rotationTimer !== null) clearInterval(this.rotationTimer);
    this.rotationTimer = null;
  }

  private async scanRotation(job: {
    signal: AbortSignal;
    onProgress: (done: number, total: number) => void;
  }): Async<{ scanned: number; tracked: number }> {
    const store = this.requireStore();
    if (!store.ok) return store;
    const listing = await store.value.list();
    if (!listing.ok) return listing;
    const total = listing.value.entries.length;
    let scanned = 0;
    let changed = false;
    for (const entry of listing.value.entries) {
      if (job.signal.aborted) return err({ kind: 'cancelled' });
      const raw = await store.value.show(entry, job.signal);
      if (raw.ok) changed = (await this.track(entry, raw.value, false)) || changed;
      else if (['cancelled', 'gpg-cancelled', 'gpg-not-found'].includes(raw.error.kind)) {
        if (changed) this.publishRotation();
        return raw.error.kind === 'gpg-not-found' ? raw : err({ kind: 'cancelled' });
      }
      scanned += 1;
      job.onProgress(scanned, total);
    }
    this.publishRotation();
    return ok({ scanned, tracked: this.rotationList().length });
  }

  private entryRotation(raw: string): EntryView['rotation'] {
    const rotation = parseEntry(raw).rotation;
    const interval = rotation.interval === null ? null : parseInterval(rotation.interval);
    return {
      ...rotation,
      status:
        interval === null
          ? null
          : rotationStatus(
              interval,
              rotation.changedAt,
              this.ports.now(),
              this.settings.rotationWarningDays,
            ),
    };
  }

  private requireStore(): Result<PasswordStore, AppError> {
    return this.store === null ? err({ kind: 'gpg-not-found' }) : ok(this.store);
  }

  private requireGpg(): Result<Gpg, AppError> {
    return this.gpg === null ? err({ kind: 'gpg-not-found' }) : ok(this.gpg);
  }

  /* --------------------------------------------------------- auto-lock */

  /** Called for every IPC request: user activity postpones the auto-lock. */
  public touch(): void {
    this.lastActivity = this.ports.now();
    this.locked = false;
  }

  /**
   * Starts the inactivity watchdog. Decrypted data only lives in renderers
   * while it is displayed; locking tells them to drop it, clears the clipboard
   * and optionally makes gpg-agent forget cached passphrases.
   */
  public startAutoLock(checkEveryMs = 15_000): void {
    this.stopAutoLock();
    this.lockTimer = setInterval(() => {
      const minutes = this.settings.autoLockMinutes;
      if (minutes === 0 || this.locked) return;
      if (this.ports.now() - this.lastActivity >= minutes * 60_000) void this.lock();
    }, checkEveryMs);
  }

  public stopAutoLock(): void {
    if (this.lockTimer !== null) clearInterval(this.lockTimer);
    this.lockTimer = null;
  }

  public async lock(): Promise<void> {
    this.locked = true;
    for (const job of this.jobs.values()) job.abort();
    this.ports.emit('app:lock', null);
    await this.ports.clipboard.clearNow();
    if (this.settings.reloadAgentOnLock) await this.gpg?.reloadAgent();
  }

  /* ------------------------------------------------------------ helpers */

  private get clipTime(): number {
    return resolveClipTime(this.settings.clipTime, this.ports.env);
  }

  private async copySecret(secret: PlainSecret, what: CopyOutcome['what']): Promise<CopyOutcome> {
    await this.ports.clipboard.copy(secret, this.clipTime);
    return { what, clearAfterSeconds: this.clipTime };
  }

  private async recordUse(entry: EntryPath): Promise<void> {
    this.ports.emit('history:changed', await this.ports.history.bump(entry));
  }

  /** Every decryption also refreshes the rotation index of that entry. */
  private async decrypt(entry: EntryPath): Async<PlainSecret> {
    const store = this.requireStore();
    if (!store.ok) return store;
    const raw = await store.value.show(entry);
    if (raw.ok) await this.track(entry, raw.value);
    return raw;
  }

  private async changed<T>(result: Result<T, AppError>): Async<T> {
    if (result.ok) {
      await this.publishListing();
      await this.publishStatus();
    }
    return result;
  }

  private async withJob<T>(
    id: string,
    run: (job: {
      signal: AbortSignal;
      onProgress: (done: number, total: number) => void;
    }) => Async<T>,
  ): Async<T> {
    const controller = new AbortController();
    this.jobs.set(id, controller);
    try {
      return await run({
        signal: controller.signal,
        onProgress: (done, total) => {
          this.ports.emit('job:progress', { id, done, total });
        },
      });
    } finally {
      this.jobs.delete(id);
    }
  }

  private async setOtp(entry: EntryPath, uri: string): Async<null> {
    const trimmed = uri.trim();
    if (!isValidOtpUri(trimmed)) return err({ kind: 'otp-invalid' });
    const store = this.requireStore();
    if (!store.ok) return store;
    const current = await store.value.show(entry);
    if (!current.ok) return current;
    return store.value.edit(entry, asPlainSecret(setOtpUri(current.value, trimmed)));
  }

  private importOtpFromImages(entry: EntryPath, images: readonly RgbaImage[]): Async<null> {
    for (const image of images) {
      const decoded = decodeQr(image);
      if (decoded !== null && isValidOtpUri(decoded)) return this.setOtp(entry, decoded);
    }
    return Promise.resolve(err({ kind: 'qr-not-found' }));
  }

  private async storeDirIsEmpty(): Promise<boolean> {
    try {
      return (await readdir(this.storeDir)).length === 0;
    } catch {
      return true;
    }
  }

  /* ----------------------------------------------------------- handlers */

  public readonly handlers: Handlers = {
    'app:status': async () => ok(await this.status()),
    'app:refresh': async () => {
      await this.refresh();
      return ok(await this.status());
    },
    'app:openManager': (input) => {
      this.ports.openManager(input?.tab);
      return Promise.resolve(DONE);
    },
    'app:hideLauncher': () => {
      this.ports.hideLauncher();
      return Promise.resolve(DONE);
    },
    'app:quit': () => {
      this.ports.quit();
      return Promise.resolve(DONE);
    },
    'app:secretVisible': ({ visible }, context) => {
      this.ports.setSecretVisible(context.senderId, visible);
      return Promise.resolve(DONE);
    },
    'app:chooseStoreDir': async () => ok(await this.ports.chooseDirectory()),
    'app:chooseGpgBinary': async () => ok(await this.ports.chooseFile('binary')),
    'settings:get': () => Promise.resolve(ok(this.settings)),
    'settings:update': async (patch) => {
      const before = this.settings;
      if (patch.shortcut !== undefined && patch.shortcut !== before.shortcut) {
        if (!this.ports.applyShortcut(patch.shortcut)) {
          return err({ kind: 'shortcut-conflict', accelerator: patch.shortcut });
        }
      }
      const after = await this.ports.settings.update(patch);
      if (after.autoStart !== before.autoStart) await this.ports.setAutoStart(after.autoStart);
      this.ports.emit('settings:changed', after);
      if (
        after.rotationWarningDays !== before.rotationWarningDays ||
        after.rotationNotifications !== before.rotationNotifications
      ) {
        this.publishRotation();
      }
      if (after.storeDir !== before.storeDir || after.gpgPath !== before.gpgPath) {
        await this.refresh();
      } else {
        await this.publishStatus();
      }
      return ok(after);
    },
    'history:get': () => Promise.resolve(ok(this.ports.history.value)),

    'store:list': async () => {
      const store = this.requireStore();
      if (!store.ok) return ok({ entries: [], folders: [] });
      return store.value.list();
    },
    'store:show': async ({ path }) => {
      const raw = await this.decrypt(path);
      if (!raw.ok) return raw;
      const parsed = parseEntry(raw.value);
      const view: EntryView = {
        path,
        password: asPlainSecret(parsed.password),
        raw: raw.value,
        fields: [...parsed.fields],
        notes: parsed.notes,
        login: parsed.login,
        url: parsed.url,
        hasOtp: parsed.otpUri !== null,
        rotation: this.entryRotation(raw.value),
      };
      return ok(view);
    },
    'store:copy': async ({ path, target }) => {
      const raw = await this.decrypt(path);
      if (!raw.ok) return raw;
      const parsed = parseEntry(raw.value);
      let value: string;
      switch (target.what) {
        case 'password':
          value = parsed.password;
          break;
        case 'login':
          value = loginFor(parsed, path);
          break;
        case 'otp': {
          if (parsed.otpUri === null) return err({ kind: 'otp-missing' });
          const code = totpCode(parsed.otpUri, this.ports.now());
          if (!code.ok) return code;
          value = code.value.code;
          break;
        }
        case 'line': {
          const line = lineOf(raw.value, target.line);
          if (line === null) return err({ kind: 'invalid-argument', message: 'no such line' });
          value = line;
          break;
        }
      }
      const outcome = await this.copySecret(asPlainSecret(value), target.what);
      await this.recordUse(path);
      return ok(outcome);
    },
    'store:openUrl': async ({ path }) => {
      const raw = await this.decrypt(path);
      if (!raw.ok) return raw;
      const url = safeHttpUrl(parseEntry(raw.value).url ?? '');
      if (url === null) return err({ kind: 'invalid-argument', message: 'no valid URL' });
      await this.ports.openExternal(url);
      await this.recordUse(path);
      return DONE;
    },
    'store:insert': async ({ path, content, kind, force, copy }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      const inserted = await this.changed(await store.value.insert(path, content, { force, kind }));
      if (inserted.ok) await this.track(path, content);
      if (inserted.ok && copy) {
        await this.copySecret(asPlainSecret(parseEntry(content).password), 'password');
        await this.recordUse(path);
      }
      return inserted;
    },
    'store:insertFromClipboard': async ({ path, force }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      const text = (await this.ports.readClipboard()).replace(/\r?\n$/, '');
      if (text.trim() === '') return err({ kind: 'clipboard-empty' });
      const inserted = await this.changed(
        await store.value.insert(path, asPlainSecret(text), { force, kind: 'given' }),
      );
      if (inserted.ok) await this.track(path, text);
      return inserted;
    },
    'store:generate': async ({ path, options, inPlace, force, copy }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      const generated = generatePassword(
        options,
        this.ports.rng ?? cryptoRandom,
        charsetOverrideFromEnv(this.ports.env),
      );
      if (!generated.ok) return generated;
      const { password, entropyBits } = generated.value;
      const date = today(this.ports.now());
      const saved = await this.changed(
        inPlace
          ? await store.value.replacePassword(path, password, (content) =>
              touchPasswordChanged(content, date),
            )
          : await store.value.insert(path, password, { force, kind: 'generated' }),
      );
      if (!saved.ok) return saved;
      await this.track(path, saved.value ?? password);
      if (copy) {
        await this.copySecret(password, 'password');
        await this.recordUse(path);
      }
      return ok({ entropyBits, clearAfterSeconds: this.clipTime });
    },
    'store:edit': async ({ path, content }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      // A new password on a rotated entry restarts its rotation period.
      const previous = await store.value.show(path);
      const passwordChanged =
        previous.ok && parseEntry(previous.value).password !== parseEntry(content).password;
      const next = asPlainSecret(
        passwordChanged ? touchPasswordChanged(content, today(this.ports.now())) : content,
      );
      const edited = await this.changed(await store.value.edit(path, next));
      if (edited.ok) await this.track(path, next);
      return edited;
    },
    'store:remove': async ({ path, recursive }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      const removed = await this.changed(await store.value.remove(path, recursive));
      if (removed.ok) {
        await this.ports.history.forget(path);
        this.ports.emit('history:changed', this.ports.history.value);
      }
      return removed;
    },
    'store:move': async ({ from, to, force }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      const result = await store.value.move(from, to, force);
      if (result.ok) await this.ports.rotationIndex.rename(from, to);
      const moved = await this.changed(result);
      if (moved.ok) {
        this.publishRotation();
        await this.ports.history.rename(from, to);
        this.ports.emit('history:changed', this.ports.history.value);
      }
      return moved;
    },
    'store:duplicate': async ({ from, to, force }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      const result = await store.value.copy(from, to, force);
      if (result.ok && (await this.ports.rotationIndex.copy(from, to))) this.publishRotation();
      return this.changed(result);
    },
    'store:grep': async ({ id, pattern, regex }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      return this.withJob(id, (job) => store.value.grep(pattern, regex, job));
    },
    'store:cancelJob': ({ id }) => {
      this.jobs.get(id)?.abort();
      return Promise.resolve(DONE);
    },
    'store:recipients': async ({ folder }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      return store.value.recipients(folder);
    },
    'store:init': async ({ id, folder, keyIds }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      return this.changed(await this.withJob(id, (job) => store.value.init(folder, keyIds, job)));
    },
    'store:qr': async ({ path, target }) => {
      const raw = await this.decrypt(path);
      if (!raw.ok) return raw;
      const parsed = parseEntry(raw.value);
      const text = target === 'password' ? parsed.password : parsed.otpUri;
      if (text === null) return err({ kind: 'otp-missing' });
      if (text === '') return err({ kind: 'invalid-argument', message: 'nothing to encode' });
      return ok({ dataUrl: await qrDataUrl(text) });
    },

    'rotation:list': () => Promise.resolve(ok(this.rotationList())),
    'rotation:configure': async ({ path, interval, changeUrl }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      const raw = await this.decrypt(path);
      if (!raw.ok) return raw;
      let content = setField(raw.value, ROTATION_KEY, interval);
      if (interval !== null && parseEntry(raw.value).rotation.changedAt === null) {
        // Turning rotation on starts the period today.
        content = setField(content, CHANGED_KEY, today(this.ports.now()));
      }
      content = setField(
        content,
        CHANGE_URL_KEY,
        changeUrl === null || changeUrl === '' ? null : changeUrl,
      );
      if (content === raw.value) return DONE;
      const edited = await this.changed(await store.value.edit(path, asPlainSecret(content)));
      if (edited.ok) await this.track(path, content);
      return edited;
    },
    'rotation:renew': async ({ path, password }) => {
      const store = this.requireStore();
      if (!store.ok) return store;
      if (password.length === 0)
        return err({ kind: 'invalid-argument', message: 'empty password' });
      const raw = await this.decrypt(path);
      if (!raw.ok) return raw;
      const content = asPlainSecret(
        setField(replaceFirstLine(raw.value, password), CHANGED_KEY, today(this.ports.now())),
      );
      const edited = await this.changed(await store.value.edit(path, content));
      if (edited.ok) await this.track(path, content);
      return edited;
    },
    'rotation:openChangeUrl': async ({ path }) => {
      const raw = await this.decrypt(path);
      if (!raw.ok) return raw;
      const parsed = parseEntry(raw.value);
      const url = safeHttpUrl(parsed.rotation.changeUrl ?? parsed.url ?? '');
      if (url === null) return err({ kind: 'invalid-argument', message: 'no valid URL' });
      await this.ports.openExternal(url);
      return DONE;
    },
    'rotation:scan': ({ id }) => this.withJob(id, (job) => this.scanRotation(job)),

    'generator:preview': (options) => {
      const generated = generatePassword(
        options,
        this.ports.rng ?? cryptoRandom,
        charsetOverrideFromEnv(this.ports.env),
      );
      if (!generated.ok) return Promise.resolve(generated);
      return Promise.resolve(
        ok({ ...generated.value, score: passwordScore(generated.value.password) }),
      );
    },

    'clipboard:peek': async ({ reveal }) => {
      const text = (await this.ports.readClipboard()).replace(/\r?\n$/, '');
      return ok({ length: text.length, text: reveal && text !== '' ? asPlainSecret(text) : null });
    },
    'clipboard:copyText': async ({ text }) => ok(await this.copySecret(text, 'line')),

    'otp:code': async ({ path }) => {
      const raw = await this.decrypt(path);
      if (!raw.ok) return raw;
      const uri = parseEntry(raw.value).otpUri;
      return uri === null ? err({ kind: 'otp-missing' }) : totpCode(uri, this.ports.now());
    },
    'otp:setUri': ({ path, uri }) => this.setOtp(path, uri),
    'otp:importImage': async ({ path }) => {
      const file = await this.ports.chooseFile('image');
      if (file === null) return err({ kind: 'cancelled' });
      const image = await this.ports.loadImage(file);
      return this.importOtpFromImages(path, image === null ? [] : [image]);
    },
    'otp:importScreen': async ({ path }) =>
      this.importOtpFromImages(path, await this.ports.captureScreens()),

    'gpg:listKeys': async ({ secretOnly }) => {
      const gpg = this.requireGpg();
      return gpg.ok ? gpg.value.listKeys(secretOnly) : gpg;
    },
    'gpg:generateKey': async ({ name, email }) => {
      const gpg = this.requireGpg();
      if (!gpg.ok) return gpg;
      // E2E/CI only: without a desktop session there is no pinentry to ask for a passphrase.
      const unprotected = this.ports.env.SESAME_TEST_UNPROTECTED_KEYS === '1';
      return gpg.value.generateKey({ name, email, ...(unprotected ? { unprotected } : {}) });
    },
    'gpg:importKey': async () => {
      const gpg = this.requireGpg();
      if (!gpg.ok) return gpg;
      const file = await this.ports.chooseFile('key');
      if (file === null) return err({ kind: 'cancelled' });
      try {
        if ((await stat(file)).size > MAX_KEY_FILE_BYTES) {
          return err({ kind: 'invalid-argument', message: 'key file too large' });
        }
        const imported = await gpg.value.importKey(await readFile(file));
        return imported.ok ? ok({ imported: imported.value }) : imported;
      } catch {
        return err({ kind: 'io', message: 'cannot read key file' });
      }
    },
    'gpg:reloadAgent': async () => {
      const gpg = this.requireGpg();
      return gpg.ok ? gpg.value.reloadAgent() : gpg;
    },

    'git:status': () => this.git.status(this.storeDir),
    'git:init': async () => {
      const store = this.requireStore();
      if (!store.ok) return store;
      return this.changed(await store.value.gitInit());
    },
    'git:pull': async () => {
      const pulled = await this.changed(await this.git.pull(this.storeDir));
      return pulled.ok ? ok({ output: pulled.value }) : pulled;
    },
    'git:push': async () => {
      const pushed = await this.git.push(this.storeDir);
      return pushed.ok ? ok({ output: pushed.value }) : pushed;
    },
    'git:log': ({ limit }) => this.git.log(this.storeDir, limit),
    'git:clone': async ({ url }) => {
      if (!(await this.storeDirIsEmpty())) {
        return err({ kind: 'invalid-argument', message: 'store directory is not empty' });
      }
      return this.changed(await this.git.clone(url, this.storeDir));
    },
    'git:setRemote': ({ url }) => this.git.setRemote(this.storeDir, url),
  };
}
