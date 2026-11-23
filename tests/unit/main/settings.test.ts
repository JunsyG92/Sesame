import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultSettings,
  defaultShortcut,
  resolveStoreDir,
  SettingsStore,
  UsageHistoryStore,
} from '../../../src/main/settings';

describe('settings', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ssm-settings-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('has per-platform default shortcuts', () => {
    expect(defaultShortcut('darwin')).toBe('Command+Shift+Space');
    expect(defaultShortcut('linux')).toBe('Control+Shift+Space');
    expect(defaultShortcut('win32')).toBe('Control+Shift+Space');
  });

  it('resolves the store directory like pass', () => {
    const home = path.resolve('/home/alice');
    expect(resolveStoreDir({ storeDir: null }, {}, home)).toBe(path.join(home, '.password-store'));
    expect(resolveStoreDir({ storeDir: null }, { PASSWORD_STORE_DIR: '/srv/pw' }, home)).toBe(
      path.resolve('/srv/pw'),
    );
    expect(resolveStoreDir({ storeDir: '/custom' }, { PASSWORD_STORE_DIR: '/srv/pw' }, home)).toBe(
      path.resolve('/custom'),
    );
    expect(resolveStoreDir({ storeDir: '' }, { PASSWORD_STORE_DIR: '' }, home)).toBe(
      path.join(home, '.password-store'),
    );
  });

  it('loads defaults, persists updates and ignores corrupted files', async () => {
    const file = path.join(dir, 'nested', 'settings.json');
    const defaults = defaultSettings({ PASSWORD_STORE_GENERATED_LENGTH: '30' }, 'linux');
    const store = new SettingsStore(file, defaults);
    expect(await store.load()).toEqual(defaults);
    expect(defaults.generator).toMatchObject({ mode: 'chars', length: 30 });

    const updated = await store.update({ clipTime: 20, theme: 'dark', language: undefined });
    expect(updated.clipTime).toBe(20);
    expect(updated.language).toBe('system');
    expect(store.value.theme).toBe('dark');

    const reloaded = new SettingsStore(file, defaults);
    expect((await reloaded.load()).clipTime).toBe(20);

    await writeFile(file, '{ not json', 'utf8');
    expect(await new SettingsStore(file, defaults).load()).toEqual(defaults);
    await writeFile(file, JSON.stringify({ clipTime: 'soon' }), 'utf8');
    expect(await new SettingsStore(file, defaults).load()).toEqual(defaults);
  });

  it('rejects invalid updates', async () => {
    const store = new SettingsStore(path.join(dir, 's.json'), defaultSettings({}, 'darwin'));
    await expect(store.update({ autoLockMinutes: -1 })).rejects.toThrow();
  });

  it('tracks usage by entry name only', async () => {
    const file = path.join(dir, 'history.json');
    let now = 1000;
    const history = new UsageHistoryStore(file, () => now);
    expect(await history.load()).toEqual({});
    await history.bump('web/github');
    now = 2000;
    await history.bump('web/github');
    await history.bump('web/gitlab');
    await history.bump('other');
    expect(history.value).toEqual({
      'web/github': { count: 2, last: 2000 },
      'web/gitlab': { count: 1, last: 2000 },
      other: { count: 1, last: 2000 },
    });
    await history.rename('web', 'sites');
    await history.rename('other', 'misc');
    expect(Object.keys(history.value).sort()).toEqual(['misc', 'sites/github', 'sites/gitlab']);
    await history.forget('sites');
    expect(history.value).toEqual({ misc: { count: 1, last: 2000 } });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(history.value);
    expect(await new UsageHistoryStore(file).load()).toEqual(history.value);
  });

  it('caps the history size by dropping the oldest entry', async () => {
    const file = path.join(dir, 'history.json');
    const seed = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [
        `e${String(index)}`,
        { count: 1, last: index + 10 },
      ]),
    );
    await writeFile(file, JSON.stringify(seed), 'utf8');
    const history = new UsageHistoryStore(file, () => 99_999);
    await history.load();
    await history.bump('fresh');
    expect(Object.keys(history.value)).toHaveLength(5000);
    expect(history.value.e0).toBeUndefined();
    expect(history.value.fresh).toEqual({ count: 1, last: 99_999 });
  });
});
