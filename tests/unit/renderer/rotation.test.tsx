import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, it } from 'vitest';
import { intervalLabel, statusLabel } from '../../../src/renderer/components/rotation';
import { createI18n } from '../../../src/renderer/i18n';
import { Launcher } from '../../../src/renderer/launcher/Launcher';
import { Manager } from '../../../src/renderer/manager/Manager';
import type { EntryView, RotationItem } from '../../../src/shared/schemas';
import { asPlainSecret, EntryPathSchema } from '../../../src/shared/types';
import { FakeApi, NO_ROTATION, ok, renderWith, SETTINGS, STATUS } from './fakeApi';

const p = (name: string) => EntryPathSchema.parse(name);

const VIEW = (rotation: EntryView['rotation'] = NO_ROTATION): EntryView => ({
  path: p('web/github'),
  password: asPlainSecret('old-pw'),
  raw: asPlainSecret('old-pw\nlogin: alice\n'),
  fields: [{ key: 'login', value: 'alice', line: 2 }],
  notes: '',
  login: 'alice',
  url: null,
  hasOtp: false,
  rotation,
});

const ITEMS: RotationItem[] = [
  {
    path: p('bank'),
    interval: '3m',
    changedAt: null,
    dueAt: null,
    daysLeft: null,
    state: 'expired',
  },
  {
    path: p('mail'),
    interval: '1m',
    changedAt: '2026-11-20',
    dueAt: '2026-12-20',
    daysLeft: 3,
    state: 'soon',
  },
  {
    path: p('web/github'),
    interval: '2m',
    changedAt: '2026-11-24',
    dueAt: '2027-01-24',
    daysLeft: 61,
    state: 'ok',
  },
];

function api(extra: ConstructorParameters<typeof FakeApi>[0] = {}) {
  return new FakeApi({
    'store:list': () => ok({ entries: [p('web/github'), p('bank'), p('mail')], folders: ['web'] }),
    'rotation:list': () => ok(ITEMS),
    ...extra,
  });
}

describe('labels', () => {
  it('formats intervals and statuses in both languages', () => {
    const en = createI18n('en').t;
    const fr = createI18n('fr').t;
    expect(intervalLabel(en, '2m')).toBe('Every 2 months');
    expect(intervalLabel(en, '1y')).toBe('Every year');
    expect(intervalLabel(fr, '1m')).toBe('Tous les mois');
    expect(intervalLabel(fr, '8w')).toBe('Toutes les 8 semaines');
    expect(intervalLabel(fr, '60d')).toBe('Tous les 60 jours');
    expect(intervalLabel(en, 'whenever')).toBe('whenever');
    expect(statusLabel(en, 'en', { dueAt: '2027-01-24', daysLeft: 61, state: 'ok' })).toBe(
      'Valid until January 24, 2027',
    );
    expect(statusLabel(fr, 'fr', { dueAt: '2027-01-24', daysLeft: 61, state: 'ok' })).toBe(
      'Valable jusqu’au 24 janvier 2027',
    );
    expect(statusLabel(en, 'en', { dueAt: 'x', daysLeft: 1, state: 'soon' })).toBe(
      'Expires tomorrow',
    );
    expect(statusLabel(fr, 'fr', { dueAt: 'x', daysLeft: 3, state: 'soon' })).toBe(
      'Expire dans 3 jours',
    );
    expect(statusLabel(en, 'en', { dueAt: 'x', daysLeft: 0, state: 'expired' })).toBe(
      'Expired today',
    );
    expect(statusLabel(en, 'en', { dueAt: 'x', daysLeft: -1, state: 'expired' })).toBe(
      'Expired yesterday',
    );
    expect(statusLabel(fr, 'fr', { dueAt: 'x', daysLeft: -12, state: 'expired' })).toBe(
      'Expiré depuis 12 jours',
    );
    expect(statusLabel(fr, 'fr', { dueAt: null, daysLeft: null, state: 'expired' })).toBe(
      'Expiré — date du dernier changement inconnue',
    );
  });
});

describe('entry renewal section', () => {
  it('turns rotation on with a preset interval and a change URL', async () => {
    const fake = api({
      'store:show': () => ok(VIEW()),
      'rotation:configure': () => ok(null),
    });
    const user = userEvent.setup();
    const view = renderWith(fake, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(await screen.findByRole('option', { name: 'web/github' }));
    const section = await screen.findByRole('region', { name: 'Renewal' });
    expect(section).toHaveTextContent('This password does not need to be renewed regularly.');
    expect(within(section).queryByRole('button', { name: /Renew now/ })).not.toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: /Renewal settings/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Renewal settings' });
    expect(await axe(dialog)).toHaveNoViolations();
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Renew this password regularly' }),
    );
    expect(within(dialog).getByLabelText('Renew')).toHaveValue('2m');
    await user.type(
      within(dialog).getByLabelText('Password change page (URL)'),
      'github.com/settings',
    );
    expect(
      within(dialog).getByText('The URL must start with http:// or https://'),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Password change page (URL)'));
    await user.type(
      within(dialog).getByLabelText('Password change page (URL)'),
      'https://github.com/settings/security',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(fake.callsTo('rotation:configure')).toEqual([
        { path: 'web/github', interval: '2m', changeUrl: 'https://github.com/settings/security' },
      ]);
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Renewal settings saved');
    expect(view.container).toBeInTheDocument();
  });

  it('accepts a custom interval and can turn rotation off', async () => {
    const fake = api({
      'store:show': () =>
        ok(
          VIEW({
            interval: '45d',
            changedAt: '2026-11-24',
            changeUrl: null,
            status: { dueAt: '2027-01-08', daysLeft: 45, state: 'ok' },
          }),
        ),
      'rotation:configure': () => ok(null),
    });
    const user = userEvent.setup();
    renderWith(fake, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(await screen.findByRole('option', { name: 'web/github' }));
    const section = await screen.findByRole('region', { name: 'Renewal' });
    expect(section).toHaveTextContent('Valid until January 8, 2027');
    expect(section).toHaveTextContent('Every 45 days');
    expect(section).toHaveTextContent('Last changed on November 24, 2026');
    await user.click(within(section).getByRole('button', { name: /Renewal settings/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Renewal settings' });
    expect(within(dialog).getByLabelText('Renew')).toHaveValue('custom');
    const count = within(dialog).getByRole('spinbutton', { name: 'Every' });
    expect(count).toHaveValue(45);
    await user.clear(count);
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    await user.type(count, '6');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Custom' }), 'w');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(fake.callsTo('rotation:configure').at(-1)).toEqual({
        path: 'web/github',
        interval: '6w',
        changeUrl: '',
      });
    });
    // The entry is reloaded after saving: look the section up again.
    const reloaded = await screen.findByRole('region', { name: 'Renewal' });
    await user.click(within(reloaded).getByRole('button', { name: /Renewal settings/ }));
    const again = await screen.findByRole('dialog', { name: 'Renewal settings' });
    await user.click(
      within(again).getByRole('checkbox', { name: 'Renew this password regularly' }),
    );
    await user.click(within(again).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(fake.callsTo('rotation:configure').at(-1)).toMatchObject({ interval: null });
    });
  });

  it('renews with a new random password, saving only after confirmation', async () => {
    let n = 0;
    const fake = api({
      'store:show': () =>
        ok(
          VIEW({
            interval: '2m',
            changedAt: '2026-09-01',
            changeUrl: 'https://github.com/settings/security',
            status: { dueAt: '2026-11-01', daysLeft: -23, state: 'expired' },
          }),
        ),
      'settings:get': () => ok(SETTINGS),
      'generator:preview': () => {
        n += 1;
        return ok({
          password: asPlainSecret(`new-random-${String(n)}`),
          entropyBits: 150,
          score: 4,
        });
      },
      'rotation:openChangeUrl': () => ok(null),
      'store:copy': () => ok({ what: 'password', clearAfterSeconds: 45 }),
      'clipboard:copyText': () => ok({ what: 'line', clearAfterSeconds: 45 }),
      'rotation:renew': () => ok(null),
    });
    const user = userEvent.setup();
    renderWith(fake, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(await screen.findByRole('option', { name: 'web/github' }));
    const section = await screen.findByRole('region', { name: 'Renewal' });
    expect(section).toHaveTextContent('Expired 23 days ago');
    await user.click(within(section).getByRole('button', { name: /Renew now/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Renew “web/github”' });
    await user.click(within(dialog).getByRole('button', { name: /Open the change page/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Copy the current password' }));
    await user.click(within(dialog).getByRole('button', { name: 'Show' }));
    expect(within(dialog).getByLabelText('Password')).toHaveTextContent('new-random-1');
    await user.click(within(dialog).getByRole('button', { name: /Regenerate/ }));
    await waitFor(() => {
      expect(within(dialog).getByLabelText('Password')).toHaveTextContent('new-random-2');
    });
    await user.click(within(dialog).getByRole('button', { name: 'Copy the new password' }));
    await user.click(within(dialog).getByRole('button', { name: /Generator options/ }));
    await user.click(within(dialog).getByRole('radio', { name: 'PIN' }));
    await waitFor(() => {
      expect(fake.callsTo('generator:preview').at(-1)).toEqual({ mode: 'pin', length: 6 });
    });
    expect(fake.callsTo('rotation:renew')).toEqual([]);
    const shown = within(dialog).getByLabelText('Password').textContent;
    await user.click(
      within(dialog).getByRole('button', { name: 'The password is changed — save' }),
    );
    await waitFor(() => {
      expect(fake.callsTo('rotation:renew')).toEqual([{ path: 'web/github', password: shown }]);
    });
    expect(fake.callsTo('rotation:openChangeUrl')).toEqual([{ path: 'web/github' }]);
    expect(fake.callsTo('store:copy')).toEqual([
      { path: 'web/github', target: { what: 'password' } },
    ]);
    expect(fake.callsTo('clipboard:copyText')).toEqual([{ text: 'new-random-2' }]);
    expect(fake.callsTo('app:secretVisible')).toContainEqual({ visible: true });
    expect(await screen.findByRole('status')).toHaveTextContent('“web/github” renewed');
  });

  it('cancelling the renewal keeps the current password', async () => {
    const fake = api({
      'store:show': () =>
        ok(
          VIEW({
            interval: '2m',
            changedAt: null,
            changeUrl: null,
            status: { dueAt: null, daysLeft: null, state: 'expired' },
          }),
        ),
      'generator:preview': () => ok({ password: asPlainSecret('x'), entropyBits: 1, score: 0 }),
    });
    const user = userEvent.setup();
    renderWith(fake, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(await screen.findByRole('option', { name: 'web/github' }));
    await user.click(await screen.findByRole('button', { name: /Renew now/ }));
    const dialog = await screen.findByRole('dialog');
    // The focus moves into the dialog, so Escape closes it and gives the focus back.
    expect(dialog).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const renew = screen.getByRole('button', { name: /Renew now/ });
    expect(renew).toHaveFocus();
    await user.click(renew);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fake.callsTo('rotation:renew')).toEqual([]);
  });
});

describe('renewal tab', () => {
  it('lists passwords by urgency with a badge on the tab, and scans the store', async () => {
    let finish: (value: ReturnType<typeof ok<{ scanned: number; tracked: number }>>) => void = () =>
      undefined;
    const fake = api({
      'rotation:scan': () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      'store:cancelJob': () => ok(null),
    });
    const user = userEvent.setup();
    const view = renderWith(fake, <Manager settings={SETTINGS} status={STATUS} />);
    const tab = await screen.findByRole('button', { name: /Renewal\s*2/ });
    await user.click(tab);
    const list = await screen.findByRole('list', { name: 'Password renewal' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('bank'),
      expect.stringContaining('mail'),
      expect.stringContaining('web/github'),
    ]);
    expect(rows[0]).toHaveTextContent('Expired — last change unknown');
    expect(rows[1]).toHaveTextContent('Expires in 3 days');
    expect(await axe(view.container)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: /Scan the store/ }));
    const id = fake.callsTo('rotation:scan')[0]?.id ?? '';
    act(() => {
      fake.emit('job:progress', { id, done: 2, total: 3 });
    });
    expect(await screen.findByRole('progressbar', { name: 'Scanned 2 / 3' })).toBeInTheDocument();
    act(() => {
      finish(ok({ scanned: 3, tracked: 3 }));
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      '3 password(s) with renewal among 3 entries',
    );

    // Live updates pushed by the main process.
    act(() => {
      fake.emit('rotation:changed', []);
    });
    expect(await screen.findByText(/No password is set to be renewed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renewal' })).toBeInTheDocument();
  });

  it('opens on the tab requested by a notification', async () => {
    window.location.hash = '#rotation';
    try {
      renderWith(api(), <Manager settings={SETTINGS} status={STATUS} />);
      expect(await screen.findByRole('heading', { name: 'Password renewal' })).toBeInTheDocument();
    } finally {
      window.location.hash = '';
    }
    const fake = api();
    renderWith(fake, <Manager settings={SETTINGS} status={STATUS} />);
    act(() => {
      fake.emit('manager:navigate', 'rotation');
    });
    expect(await screen.findAllByRole('heading', { name: 'Password renewal' })).not.toHaveLength(0);
  });

  it('renews from the list', async () => {
    const fake = api({
      'generator:preview': () =>
        ok({ password: asPlainSecret('fresh'), entropyBits: 100, score: 4 }),
      'rotation:renew': () => ok(null),
    });
    const user = userEvent.setup();
    renderWith(fake, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(await screen.findByRole('button', { name: /Renewal/ }));
    await user.click(await screen.findByRole('button', { name: 'Renew now bank' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renew “bank”' });
    await user.click(
      await within(dialog).findByRole('button', { name: 'The password is changed — save' }),
    );
    await waitFor(() => {
      expect(fake.callsTo('rotation:renew')).toEqual([{ path: 'bank', password: 'fresh' }]);
    });
  });

  it('configures notifications in the settings', async () => {
    const fake = api({ 'settings:update': () => ok(SETTINGS) });
    const user = userEvent.setup();
    renderWith(fake, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Notify me when passwords must be renewed' }),
    );
    // Controlled by the saved settings: set the value at once.
    fireEvent.change(screen.getByLabelText('Warn this many days before the deadline'), {
      target: { value: '14' },
    });
    fireEvent.change(screen.getByLabelText('Warn this many days before the deadline'), {
      target: { value: '500' },
    });
    expect(fake.callsTo('settings:update')).toContainEqual({ rotationNotifications: false });
    expect(fake.callsTo('settings:update')).toContainEqual({ rotationWarningDays: 14 });
    expect(fake.callsTo('settings:update')).not.toContainEqual({ rotationWarningDays: 500 });
  });
});

describe('launcher', () => {
  it('shows a banner and marks expired passwords until they are renewed', async () => {
    const fake = api();
    const user = userEvent.setup();
    renderWith(fake, <Launcher settings={SETTINGS} mac={false} />);
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('A password has expired');
    const bank = await screen.findByRole('option', { name: /bank/ });
    expect(bank).toHaveTextContent('expired');
    expect(screen.getByRole('option', { name: /mail/ })).not.toHaveTextContent('expired');
    await user.click(within(banner).getByRole('button', { name: /Renew/ }));
    expect(fake.callsTo('app:openManager')).toEqual([{ tab: 'rotation' }]);
    act(() => {
      fake.emit('rotation:changed', ITEMS.slice(1));
    });
    await waitFor(() => {
      expect(screen.queryByText('A password has expired')).not.toBeInTheDocument();
    });
  });

  it('shows the renewal status in the entry details, in French', async () => {
    const fake = api({
      'store:show': () =>
        ok(
          VIEW({
            interval: '2m',
            changedAt: '2026-11-20',
            changeUrl: null,
            status: { dueAt: '2026-11-27', daysLeft: 3, state: 'soon' },
          }),
        ),
    });
    const user = userEvent.setup();
    renderWith(fake, <Launcher settings={SETTINGS} mac={false} />, 'fr');
    await user.type(screen.getByRole('combobox'), 'github{Tab}');
    const section = await screen.findByRole('region', { name: 'Renouvellement' });
    expect(section).toHaveTextContent('Expire dans 3 jours');
    expect(
      within(section).getByRole('button', { name: /Renouveler maintenant/ }),
    ).toBeInTheDocument();
    expect(
      within(section).queryByRole('button', { name: /Paramètres de renouvellement/ }),
    ).not.toBeInTheDocument();
  });
});
