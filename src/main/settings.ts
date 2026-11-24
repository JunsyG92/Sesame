import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  SettingsSchema,
  UsageHistorySchema,
  type Settings,
  type SettingsPatch,
  type UsageHistory,
} from '../shared/schemas';
import { defaultGeneratorOptions } from './generator';
import type { Platform } from './store/gpg';

export function defaultShortcut(platform: Platform): string {
  return platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Shift+Space';
}

export function defaultSettings(env: NodeJS.ProcessEnv, platform: Platform): Settings {
  return {
    shortcut: defaultShortcut(platform),
    storeDir: null,
    gpgPath: null,
    clipTime: null,
    generator: defaultGeneratorOptions(env),
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
}

/** Store location: settings, then `$PASSWORD_STORE_DIR`, then `~/.password-store`. */
export function resolveStoreDir(
  settings: Pick<Settings, 'storeDir'>,
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const fromEnv = env.PASSWORD_STORE_DIR;
  if (settings.storeDir !== null && settings.storeDir !== '')
    return path.resolve(settings.storeDir);
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  return path.join(home, '.password-store');
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

/** Generic validated JSON document persisted in the user-data directory. */
class JsonFile<S extends z.ZodType> {
  public constructor(
    private readonly file: string,
    private readonly schema: S,
  ) {}

  public async read(): Promise<z.infer<S> | null> {
    const parsed = this.schema.safeParse(await readJson(this.file));
    return parsed.success ? parsed.data : null;
  }

  public write(value: z.infer<S>): Promise<void> {
    return writeJson(this.file, value);
  }
}

export class SettingsStore {
  private current: Settings;
  private readonly file: JsonFile<ReturnType<typeof SettingsSchema.partial>>;

  public constructor(
    file: string,
    private readonly defaults: Settings,
  ) {
    this.current = defaults;
    this.file = new JsonFile(file, SettingsSchema.partial());
  }

  public get value(): Settings {
    return this.current;
  }

  /** Loads the file; unknown or invalid content falls back to the defaults. */
  public async load(): Promise<Settings> {
    const stored = await this.file.read();
    this.current = SettingsSchema.parse({ ...this.defaults, ...(stored ?? {}) });
    return this.current;
  }

  public async update(patch: SettingsPatch): Promise<Settings> {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    this.current = SettingsSchema.parse({ ...this.current, ...defined });
    await this.file.write(this.current);
    return this.current;
  }
}

const MAX_HISTORY = 5000;

/**
 * Local usage statistics used to rank search results. It only ever contains
 * entry names, counters and timestamps — never secrets.
 */
export class UsageHistoryStore {
  private current: UsageHistory = {};
  private readonly file: JsonFile<typeof UsageHistorySchema>;

  public constructor(
    file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new JsonFile(file, UsageHistorySchema);
  }

  public get value(): UsageHistory {
    return this.current;
  }

  public async load(): Promise<UsageHistory> {
    this.current = (await this.file.read()) ?? {};
    return this.current;
  }

  public async bump(name: string): Promise<UsageHistory> {
    const previous = this.current[name];
    const next = {
      ...this.current,
      [name]: { count: (previous?.count ?? 0) + 1, last: this.now() },
    };
    const names = Object.keys(next);
    if (names.length > MAX_HISTORY) {
      const oldest = names.sort((a, b) => (next[a]?.last ?? 0) - (next[b]?.last ?? 0))[0];
      if (oldest !== undefined) Reflect.deleteProperty(next, oldest);
    }
    this.current = next;
    await this.file.write(this.current);
    return this.current;
  }

  public async rename(from: string, to: string): Promise<void> {
    const next: UsageHistory = {};
    for (const [name, usage] of Object.entries(this.current)) {
      if (name === from) next[to] = usage;
      else if (name.startsWith(`${from}/`)) next[to + name.slice(from.length)] = usage;
      else next[name] = usage;
    }
    this.current = next;
    await this.file.write(this.current);
  }

  public async forget(name: string): Promise<void> {
    this.current = Object.fromEntries(
      Object.entries(this.current).filter(([key]) => key !== name && !key.startsWith(`${name}/`)),
    );
    await this.file.write(this.current);
  }
}

export const RotationIndexSchema = z.record(
  z.string(),
  z.object({ interval: z.string(), changedAt: z.string().nullable() }),
);
export type RotationIndex = z.infer<typeof RotationIndexSchema>;
export type RotationRecord = RotationIndex[string];

const sameRecord = (a: RotationRecord | undefined, b: RotationRecord | null): boolean =>
  a === undefined
    ? b === null
    : b !== null && a.interval === b.interval && a.changedAt === b.changedAt;

/**
 * Local index of rotated entries: entry name, interval and date of the last
 * change. It lets Sesame compute expirations without decrypting anything in
 * the background. It never contains secrets; the source of truth stays the
 * entry itself and the index is refreshed whenever an entry is decrypted.
 */
export class RotationIndexStore {
  private current: RotationIndex = {};
  private readonly file: JsonFile<typeof RotationIndexSchema>;

  public constructor(file: string) {
    this.file = new JsonFile(file, RotationIndexSchema);
  }

  public get value(): RotationIndex {
    return this.current;
  }

  public async load(): Promise<RotationIndex> {
    this.current = (await this.file.read()) ?? {};
    return this.current;
  }

  private async save(next: RotationIndex): Promise<boolean> {
    this.current = next;
    await this.file.write(next);
    return true;
  }

  /** Records (or forgets, with `null`) one entry; returns whether anything changed. */
  public async set(path: string, record: RotationRecord | null): Promise<boolean> {
    if (sameRecord(this.current[path], record)) return false;
    const next = { ...this.current };
    if (record === null) Reflect.deleteProperty(next, path);
    else next[path] = record;
    return this.save(next);
  }

  /** Follows `pass mv` (entries and folders). */
  public async rename(from: string, to: string): Promise<boolean> {
    let changed = false;
    const next: RotationIndex = {};
    for (const [name, record] of Object.entries(this.current)) {
      if (name === from || name.startsWith(`${from}/`)) {
        next[to + name.slice(from.length)] = record;
        changed = true;
      } else next[name] = record;
    }
    return changed ? this.save(next) : false;
  }

  /** Follows `pass cp` (entries and folders). */
  public async copy(from: string, to: string): Promise<boolean> {
    const next = { ...this.current };
    let changed = false;
    for (const [name, record] of Object.entries(this.current)) {
      if (name === from || name.startsWith(`${from}/`)) {
        next[to + name.slice(from.length)] = record;
        changed = true;
      }
    }
    return changed ? this.save(next) : false;
  }

  /** Drops entries that no longer exist (removed with `pass rm`, a git pull…). */
  public async prune(existing: readonly string[]): Promise<boolean> {
    const keep = new Set(existing);
    const names = Object.keys(this.current);
    if (names.every((name) => keep.has(name))) return false;
    return this.save(
      Object.fromEntries(Object.entries(this.current).filter(([name]) => keep.has(name))),
    );
  }
}
