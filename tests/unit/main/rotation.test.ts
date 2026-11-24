import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RotationIndexStore } from '../../../src/main/settings';
import type { GpgKey } from '../../../src/shared/schemas';
import { asPlainSecret, ROOT_FOLDER } from '../../../src/shared/types';
import { createSandbox, entry, keyId, unwrap, type Sandbox } from '../../helpers/gpgEnv';
import { createHarness, type Harness } from '../../helpers/services';

const DAY = 86_400_000;
const at = (date: string): number => Date.parse(`${date}T12:00:00Z`);
const secret = asPlainSecret;

describe('RotationIndexStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ssm-rot-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records, renames, copies and prunes entries without storing secrets', async () => {
    const file = path.join(dir, 'rotation.json');
    const index = new RotationIndexStore(file);
    expect(await index.load()).toEqual({});
    const record = { interval: '2m', changedAt: '2026-11-24' };
    expect(await index.set('web/a', record)).toBe(true);
    expect(await index.set('web/a', { ...record })).toBe(false);
    expect(await index.set('other', null)).toBe(false);
    expect(await index.set('web/b', { interval: '1y', changedAt: null })).toBe(true);
    expect(await index.rename('web', 'sites')).toBe(true);
    expect(await index.rename('nothing', 'x')).toBe(false);
    expect(await index.copy('sites/a', 'copy')).toBe(true);
    expect(await index.copy('nothing', 'x')).toBe(false);
    expect(Object.keys(index.value).sort()).toEqual(['copy', 'sites/a', 'sites/b']);
    expect(await index.prune(['copy', 'sites/a', 'sites/b', 'extra'])).toBe(false);
    expect(await index.prune(['copy'])).toBe(true);
    expect(await index.set('copy', null)).toBe(true);
    expect(index.value).toEqual({});
    await index.set('x', record);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ x: record });
    expect(await new RotationIndexStore(file).load()).toEqual({ x: record });
  });
});

describe('Services: password rotation', () => {
  let sandbox: Sandbox;
  let alice: GpgKey;
  let h: Harness;

  beforeEach(async () => {
    sandbox = await createSandbox();
    alice = await sandbox.newKey('Alice');
    h = await createHarness(sandbox);
    h.now = at('2026-11-24');
    unwrap(await h.call('store:init', { id: 'i', folder: ROOT_FOLDER, keyIds: [keyId(alice)] }));
    unwrap(await h.call('git:init', undefined));
    unwrap(
      await h.call('store:insert', {
        path: entry('web/github'),
        content: secret('old-pw\nlogin: alice\nurl: https://github.com\n'),
        kind: 'given',
        force: false,
        copy: false,
      }),
    );
  });
  afterEach(async () => {
    h.services.stopRotationMonitor();
    await sandbox.cleanup();
  });

  const show = async (name: string): Promise<string> =>
    unwrap(await sandbox.store.show(entry(name)));

  it('configures rotation inside the entry, in a pass-compatible way', async () => {
    unwrap(
      await h.call('rotation:configure', {
        path: entry('web/github'),
        interval: '2m',
        changeUrl: 'https://github.com/settings/security',
      }),
    );
    expect(await show('web/github')).toBe(
      'old-pw\nlogin: alice\nurl: https://github.com\nrotation: 2m\npassword-changed: 2026-11-24\nchange-url: https://github.com/settings/security\n',
    );
    expect(unwrap(await h.call('rotation:list', undefined))).toEqual([
      {
        path: 'web/github',
        interval: '2m',
        changedAt: '2026-11-24',
        dueAt: '2027-01-24',
        daysLeft: 61,
        state: 'ok',
      },
    ]);
    expect(h.last('rotation:changed')).toHaveLength(1);
    const view = unwrap(await h.call('store:show', { path: entry('web/github') }));
    expect(view.rotation).toEqual({
      interval: '2m',
      changedAt: '2026-11-24',
      changeUrl: 'https://github.com/settings/security',
      status: { dueAt: '2027-01-24', daysLeft: 61, state: 'ok' },
    });
    expect(view.fields.map((field) => field.key)).toEqual(['login', 'url']);

    // Re-configuring keeps the original change date; an identical request is a no-op.
    const commits = unwrap(await h.call('git:log', { limit: 50 })).length;
    unwrap(
      await h.call('rotation:configure', {
        path: entry('web/github'),
        interval: '2m',
        changeUrl: 'https://github.com/settings/security',
      }),
    );
    expect(unwrap(await h.call('git:log', { limit: 50 }))).toHaveLength(commits);

    // Turning it off removes the rotation and the URL, and the entry leaves the index.
    unwrap(
      await h.call('rotation:configure', {
        path: entry('web/github'),
        interval: null,
        changeUrl: '',
      }),
    );
    expect(await show('web/github')).toBe(
      'old-pw\nlogin: alice\nurl: https://github.com\npassword-changed: 2026-11-24\n',
    );
    expect(unwrap(await h.call('rotation:list', undefined))).toEqual([]);
    expect(
      unwrap(await h.call('store:show', { path: entry('web/github') })).rotation.status,
    ).toBeNull();
  });

  it('renews with a new password, keeping everything else, and restarts the period', async () => {
    unwrap(
      await h.call('rotation:configure', {
        path: entry('web/github'),
        interval: '2m',
        changeUrl: null,
      }),
    );
    h.now = at('2027-02-01');
    expect(unwrap(await h.call('rotation:list', undefined))[0]?.state).toBe('expired');
    expect(
      await h.call('rotation:renew', { path: entry('web/github'), password: secret('') }),
    ).toEqual({ ok: false, error: { kind: 'invalid-argument', message: 'empty password' } });
    unwrap(
      await h.call('rotation:renew', { path: entry('web/github'), password: secret('new-pw') }),
    );
    expect(await show('web/github')).toBe(
      'new-pw\nlogin: alice\nurl: https://github.com\nrotation: 2m\npassword-changed: 2027-02-01\n',
    );
    expect(unwrap(await h.call('rotation:list', undefined))[0]).toMatchObject({
      changedAt: '2027-02-01',
      dueAt: '2027-04-01',
      state: 'ok',
    });
    expect(
      await h.call('rotation:renew', { path: entry('missing'), password: secret('x') }),
    ).toMatchObject({ ok: false, error: { kind: 'entry-not-found' } });
  });

  it('records the change date when the password is edited or regenerated in place', async () => {
    unwrap(
      await h.call('rotation:configure', {
        path: entry('web/github'),
        interval: '30d',
        changeUrl: null,
      }),
    );
    h.now = at('2026-12-10');
    // Editing something else does not count as a password change.
    const current = await show('web/github');
    unwrap(
      await h.call('store:edit', {
        path: entry('web/github'),
        content: secret(`${current}note\n`),
      }),
    );
    expect(await show('web/github')).toContain('password-changed: 2026-11-24');
    unwrap(
      await h.call('store:edit', {
        path: entry('web/github'),
        content: secret((await show('web/github')).replace('old-pw', 'edited-pw')),
      }),
    );
    expect(await show('web/github')).toContain('password-changed: 2026-12-10');
    h.now = at('2026-12-20');
    unwrap(
      await h.call('store:generate', {
        path: entry('web/github'),
        options: { mode: 'pin', length: 6 },
        inPlace: true,
        force: false,
        copy: false,
      }),
    );
    const regenerated = await show('web/github');
    expect(regenerated).toMatch(/^\d{6}\n/);
    expect(regenerated).toContain('password-changed: 2026-12-20');
    expect(unwrap(await h.call('rotation:list', undefined))[0]?.changedAt).toBe('2026-12-20');
  });

  it('opens the change URL, falling back to the entry URL', async () => {
    unwrap(await h.call('rotation:openChangeUrl', { path: entry('web/github') }));
    unwrap(
      await h.call('rotation:configure', {
        path: entry('web/github'),
        interval: '1y',
        changeUrl: 'https://github.com/settings/security',
      }),
    );
    unwrap(await h.call('rotation:openChangeUrl', { path: entry('web/github') }));
    expect(h.opened).toEqual(['https://github.com/', 'https://github.com/settings/security']);
    unwrap(
      await h.call('store:insert', {
        path: entry('nourl'),
        content: secret('pw\n'),
        kind: 'given',
        force: false,
        copy: false,
      }),
    );
    expect(await h.call('rotation:openChangeUrl', { path: entry('nourl') })).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'no valid URL' },
    });
  });

  it('follows moves, copies and removals of rotated entries', async () => {
    unwrap(
      await h.call('rotation:configure', {
        path: entry('web/github'),
        interval: '2m',
        changeUrl: null,
      }),
    );
    unwrap(await h.call('store:move', { from: entry('web'), to: entry('sites'), force: false }));
    expect(unwrap(await h.call('rotation:list', undefined)).map((item) => item.path)).toEqual([
      'sites/github',
    ]);
    unwrap(
      await h.call('store:duplicate', {
        from: entry('sites/github'),
        to: entry('copy'),
        force: false,
      }),
    );
    expect(unwrap(await h.call('rotation:list', undefined)).map((item) => item.path)).toEqual([
      'copy',
      'sites/github',
    ]);
    unwrap(await h.call('store:remove', { path: entry('sites'), recursive: true }));
    expect(unwrap(await h.call('rotation:list', undefined)).map((item) => item.path)).toEqual([
      'copy',
    ]);
    // Overwriting with an entry that has no rotation drops it from the index.
    unwrap(
      await h.call('store:insert', {
        path: entry('copy'),
        content: secret('plain\n'),
        kind: 'given',
        force: true,
        copy: false,
      }),
    );
    expect(unwrap(await h.call('rotation:list', undefined))).toEqual([]);
  });

  it('learns about rotation written by pass, and scans the whole store on demand', async () => {
    // Entries edited outside Sesame: rotation without a date counts as expired.
    unwrap(
      await sandbox.store.insert(entry('bank'), secret('pw\nrotation: 3m\n'), {
        force: false,
        kind: 'given',
      }),
    );
    unwrap(
      await sandbox.store.insert(
        entry('mail'),
        secret('pw\nrotation: 1m\npassword-changed: 2026-11-20\n'),
        {
          force: false,
          kind: 'given',
        },
      ),
    );
    unwrap(
      await sandbox.store.insert(entry('weird'), secret('pw\nrotation: sometimes\n'), {
        force: false,
        kind: 'given',
      }),
    );
    expect(unwrap(await h.call('rotation:list', undefined))).toEqual([]);
    // Simply viewing an entry is enough to index it.
    unwrap(await h.call('store:show', { path: entry('bank') }));
    expect(unwrap(await h.call('rotation:list', undefined))).toEqual([
      {
        path: 'bank',
        interval: '3m',
        changedAt: null,
        dueAt: null,
        daysLeft: null,
        state: 'expired',
      },
    ]);
    const result = unwrap(await h.call('rotation:scan', { id: 'scan-1' }));
    expect(result).toEqual({ scanned: 4, tracked: 2 });
    expect(
      unwrap(await h.call('rotation:list', undefined)).map((item) => [item.path, item.state]),
    ).toEqual([
      ['bank', 'expired'],
      ['mail', 'ok'],
    ]);
    expect(h.events.filter((event) => event.event === 'job:progress').at(-1)?.payload).toEqual({
      id: 'scan-1',
      done: 4,
      total: 4,
    });
  });

  it('scan can be cancelled', async () => {
    const pending = h.call('rotation:scan', { id: 'scan-2' });
    unwrap(await h.call('store:cancelJob', { id: 'scan-2' }));
    expect(await pending).toEqual({ ok: false, error: { kind: 'cancelled' } });
  });

  it('notifies about expiring and expired passwords once a day, and opens the rotation tab', async () => {
    unwrap(
      await h.call('rotation:configure', {
        path: entry('web/github'),
        interval: '30d',
        changeUrl: null,
      }),
    );
    expect(h.notifications).toEqual([]);

    h.now = at('2026-12-20'); // 4 days left: "expires soon"
    h.services.checkRotation();
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.title).toBe('Un mot de passe expire bientôt');
    expect(h.notifications[0]?.body).toContain('web/github');
    h.services.checkRotation();
    expect(h.notifications).toHaveLength(1);

    h.now = at('2026-12-24'); // deadline reached
    h.services.checkRotation();
    expect(h.notifications).toHaveLength(2);
    expect(h.notifications[1]?.title).toBe('Un mot de passe a expiré');
    h.notifications[1]?.click();
    expect(h.calls).toContain('openManager:rotation');

    // Still expired the next day: reminded again.
    h.now += DAY;
    h.services.checkRotation();
    expect(h.notifications).toHaveLength(3);

    // Several expired passwords, in English.
    unwrap(await h.call('settings:update', { language: 'en' }));
    for (const name of ['a', 'b', 'c', 'd']) {
      unwrap(
        await sandbox.store.insert(
          entry(name),
          secret('pw\nrotation: 1d\npassword-changed: 2026-01-01\n'),
          {
            force: false,
            kind: 'given',
          },
        ),
      );
      unwrap(await h.call('store:show', { path: entry(name) }));
    }
    expect(h.notifications.at(-1)?.title).toBe('5 passwords have expired');
    expect(h.notifications.at(-1)?.body).toMatch(/…\nClick to renew\.$/);

    // Renewed: nothing left to report.
    for (const name of ['a', 'b', 'c', 'd', 'web/github']) {
      unwrap(await h.call('rotation:renew', { path: entry(name), password: secret('fresh') }));
    }
    const count = h.notifications.length;
    h.services.checkRotation();
    expect(h.notifications).toHaveLength(count);
  });

  it('respects the notification settings and re-checks periodically', async () => {
    vi.useFakeTimers();
    try {
      unwrap(
        await h.call('rotation:configure', {
          path: entry('web/github'),
          interval: '30d',
          changeUrl: null,
        }),
      );
      unwrap(await h.call('settings:update', { rotationNotifications: false }));
      h.now = at('2027-01-30');
      h.services.startRotationMonitor(1000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(h.notifications).toEqual([]);
      unwrap(await h.call('settings:update', { rotationNotifications: true }));
      expect(h.notifications).toHaveLength(1);
      unwrap(await h.call('settings:update', { rotationWarningDays: 30 }));
      expect(h.last('rotation:changed')?.[0]?.state).toBe('expired');
      h.now += DAY;
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.notifications).toHaveLength(2);
      h.services.stopRotationMonitor();
      h.now += DAY;
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.notifications).toHaveLength(2);
    } finally {
      h.services.stopRotationMonitor();
      vi.useRealTimers();
    }
  });

  it('opens the manager on a given tab', async () => {
    unwrap(await h.call('app:openManager', { tab: 'rotation' }));
    unwrap(await h.call('app:openManager', undefined));
    expect(h.calls.slice(-2)).toEqual(['openManager:rotation', 'openManager']);
  });
});
