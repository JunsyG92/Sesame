import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Launcher } from '../../../src/renderer/launcher/Launcher';
import { asPlainSecret, EntryPathSchema } from '../../../src/shared/types';
import { FakeApi, fail, ok, renderWith, SETTINGS } from './fakeApi';

const p = (name: string) => EntryPathSchema.parse(name);
const ENTRIES = ['web/github.com/alice', 'web/gitlab.com/alice', 'mail/proton', 'bank'].map(p);

function setup(api = new FakeApi(), mac = false) {
  api.handlers['store:list'] = () =>
    ok({ entries: ENTRIES, folders: ['web', 'web/github.com', 'web/gitlab.com', 'mail'] });
  const user = userEvent.setup();
  const view = renderWith(api, <Launcher settings={SETTINGS} mac={mac} />);
  return { api, user, view, input: screen.getByRole('combobox') };
}

const options = () => screen.queryAllByRole('option');
const selected = () => options().find((option) => option.getAttribute('aria-selected') === 'true');

describe('Launcher', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is accessible and focuses the search field', async () => {
    const { view, input } = setup();
    await waitFor(() => {
      expect(options()).toHaveLength(4);
    });
    expect(input).toHaveFocus();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('filters entries with highlighted matches and navigates with the arrow keys', async () => {
    const { user, input } = setup();
    await user.type(input, 'git');
    await waitFor(() => {
      expect(options()[0]).toHaveTextContent('web/github.com/alice');
    });
    expect(options()[1]).toHaveTextContent('web/gitlab.com/alice');
    expect(options()[0]?.querySelector('mark')).toHaveTextContent('git');
    expect(selected()).toBe(options()[0]);
    expect(input).toHaveAttribute('aria-activedescendant', 'launcher-item-0');
    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe(options()[1]);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(selected()).toBe(options().at(-1));
    await user.keyboard('{ArrowUp}'.repeat(10));
    expect(selected()).toBe(options()[0]);
  });

  it('copies the password on Enter, the login on Shift+Enter, then hides', async () => {
    const api = new FakeApi({
      'store:copy': ({ target }) =>
        ok({ what: target.what === 'line' ? 'line' : target.what, clearAfterSeconds: 45 }),
    });
    const { user, input } = setup(api);
    await user.type(input, 'proton');
    await waitFor(() => {
      expect(options()[0]).toHaveTextContent('mail/proton');
    });
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(api.callsTo('app:hideLauncher')).toHaveLength(1);
    });
    expect(api.callsTo('store:copy')).toEqual([
      { path: 'mail/proton', target: { what: 'password' } },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Password copied — cleared in 45 s');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await waitFor(() => {
      expect(api.callsTo('store:copy')[1]).toEqual({
        path: 'mail/proton',
        target: { what: 'login' },
      });
    });
  });

  it('handles Ctrl+O (OTP), Ctrl+U (URL), Ctrl+E (edit) and Cmd on macOS', async () => {
    const api = new FakeApi({
      'store:copy': () => fail({ kind: 'otp-missing' }),
      'store:openUrl': () => ok(null),
      'store:show': ({ path }) =>
        ok({
          path,
          password: asPlainSecret('pw'),
          raw: asPlainSecret('pw\nlogin: a\n'),
          fields: [{ key: 'login', value: 'a', line: 2 }],
          notes: '',
          login: 'a',
          url: null,
          hasOtp: false,
        }),
    });
    const { user, input } = setup(api, true);
    await user.type(input, 'bank');
    await waitFor(() => {
      expect(options()[0]).toHaveTextContent('bank');
    });
    await user.keyboard('{Control>}o{/Control}');
    expect(api.callsTo('store:copy')).toHaveLength(0);
    await user.keyboard('{Meta>}o{/Meta}');
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('This entry has no one-time code.');
    });
    await user.keyboard('{Meta>}u{/Meta}');
    await waitFor(() => {
      expect(api.callsTo('store:openUrl')).toEqual([{ path: 'bank' }]);
    });
    await user.keyboard('{Meta>}e{/Meta}');
    expect(await screen.findByRole('textbox', { name: 'Content' })).toHaveValue('pw\nlogin: a\n');
    await user.keyboard('{Escape}');
    expect(await screen.findByText('Edit', { exact: false })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(options().length).toBeGreaterThan(0);
    });
  });

  it('shows the details of an entry with Tab and copies a field', async () => {
    const api = new FakeApi({
      'store:show': ({ path }) =>
        ok({
          path,
          password: asPlainSecret('pw'),
          raw: asPlainSecret('pw\nuser: bob\npin: 1234\n'),
          fields: [
            { key: 'user', value: 'bob', line: 2 },
            { key: 'pin', value: '1234', line: 3 },
          ],
          notes: '',
          login: 'bob',
          url: null,
          hasOtp: false,
        }),
      'store:copy': ({ target }) =>
        ok({ what: target.what === 'line' ? 'line' : target.what, clearAfterSeconds: 10 }),
    });
    const { user, input } = setup(api);
    await user.type(input, 'bank');
    await waitFor(() => {
      expect(options()[0]).toHaveTextContent('bank');
    });
    await user.keyboard('{Tab}');
    expect(await screen.findByText('bob')).toBeInTheDocument();
    expect(screen.queryByText('pw')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy pin' }));
    await waitFor(() => {
      expect(api.callsTo('store:copy')).toEqual([
        { path: 'bank', target: { what: 'line', line: 3 } },
      ]);
    });
    // Revealing the password marks the window as showing a secret.
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(screen.getByLabelText('Password')).toHaveTextContent('pw');
    expect(api.callsTo('app:secretVisible')).toContainEqual({ visible: true });
  });

  it('offers to create a missing entry, after strong matches only', async () => {
    const { user, input } = setup();
    await user.type(input, 'web/new.example/me');
    await waitFor(() => {
      expect(options()[0]).toHaveTextContent(
        'Create “web/new.example/me” with a generated password',
      );
    });
    expect(options()[1]).toHaveTextContent('from the clipboard');
    expect(options()[2]).toHaveTextContent('by typing the password');
    await user.clear(input);
    await user.type(input, 'githu');
    await waitFor(() => {
      expect(options()[0]).toHaveTextContent('web/github.com/alice');
    });
    expect(options()[1]).toHaveTextContent('Create “githu”');
    await user.clear(input);
    await user.type(input, 'bank');
    await waitFor(() => {
      expect(options()).toHaveLength(1);
    });
  });

  it('creates an entry with a generated password, copies it and hides', async () => {
    const api = new FakeApi({
      'store:generate': () => ok({ entropyBits: 163, clearAfterSeconds: 45 }),
    });
    const { user, input } = setup(api);
    await user.type(input, 'newsite{Enter}');
    await waitFor(() => {
      expect(api.callsTo('store:generate')).toEqual([
        { path: 'newsite', options: SETTINGS.generator, inPlace: false, force: false, copy: true },
      ]);
    });
    expect(await screen.findByRole('status')).toHaveTextContent(
      '“newsite” created, password copied',
    );
    await waitFor(
      () => {
        expect(api.callsTo('app:hideLauncher')).toHaveLength(1);
      },
      { timeout: 3000 },
    );
  });

  it('creates with Ctrl+G and adjusts the generator first with Tab', async () => {
    const api = new FakeApi({
      'store:generate': () => ok({ entropyBits: 40, clearAfterSeconds: 45 }),
      'generator:preview': () =>
        ok({ password: asPlainSecret('123456'), entropyBits: 19.9, score: 1 }),
    });
    const { user, input } = setup(api);
    await user.type(input, 'pin-code');
    await user.keyboard('{Tab}');
    const panel = await screen.findByRole('group', { name: 'Password generator' });
    await user.click(within(panel).getByRole('radio', { name: 'PIN' }));
    expect(await within(panel).findByText('Weak')).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Save and copy' }));
    await waitFor(() => {
      expect(api.callsTo('store:generate')[0]?.options).toEqual({ mode: 'pin', length: 6 });
    });
    await user.clear(input);
    await user.type(input, 'other');
    await user.keyboard('{Control>}g{/Control}');
    await waitFor(() => {
      expect(api.callsTo('store:generate')).toHaveLength(2);
    });
  });

  it('creates from the clipboard with a masked preview and a reveal button', async () => {
    const api = new FakeApi({
      'clipboard:peek': ({ reveal }) =>
        ok({ length: 9, text: reveal ? asPlainSecret('s3cr3t-pw') : null }),
      'store:insertFromClipboard': () => ok(null),
    });
    const { user, input } = setup(api);
    await user.type(input, 'new-site{ArrowDown}');
    await waitFor(() => {
      expect(selected()).toHaveTextContent('Clipboard: 9 characters');
    });
    expect(screen.queryByText('s3cr3t-pw')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reveal clipboard content' }));
    expect(await screen.findByText('s3cr3t-pw')).toBeInTheDocument();
    expect(api.callsTo('app:secretVisible')).toContainEqual({ visible: true });
    await user.click(screen.getByRole('button', { name: 'Hide clipboard content' }));
    expect(screen.queryByText('s3cr3t-pw')).not.toBeInTheDocument();
    input.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(api.callsTo('store:insertFromClipboard')).toEqual([
        { path: 'new-site', force: false },
      ]);
    });
    expect(await screen.findByRole('status')).toHaveTextContent('“new-site” created');
  });

  it('reports an empty clipboard', async () => {
    const api = new FakeApi({
      'store:insertFromClipboard': () => fail({ kind: 'clipboard-empty' }),
    });
    const { user, input } = setup(api);
    await user.type(input, 'x{ArrowDown}');
    expect(await screen.findByText('The clipboard is empty')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('The clipboard is empty.');
  });

  it('creates by typing the password, with login and URL', async () => {
    const api = new FakeApi({ 'store:insert': () => ok(null) });
    const { user, input } = setup(api);
    await user.type(input, 'forum{ArrowDown}{ArrowDown}{Enter}');
    const password = await screen.findByLabelText('Password');
    await user.type(password, 'typed-secret');
    await user.type(screen.getByLabelText('Login'), 'me');
    await user.type(screen.getByLabelText('URL'), 'forum.example');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(api.callsTo('store:insert')).toEqual([
        {
          path: 'forum',
          content: 'typed-secret\nlogin: me\nurl: forum.example\n',
          kind: 'given',
          force: false,
          copy: true,
        },
      ]);
    });
  });

  it('asks before overwriting an existing entry', async () => {
    let attempts = 0;
    const api = new FakeApi({
      'store:generate': ({ path, force }) => {
        attempts += 1;
        return force
          ? ok({ entropyBits: 1, clearAfterSeconds: 45 })
          : fail({ kind: 'entry-exists', path });
      },
    });
    const { user, input } = setup(api);
    await user.type(input, 'racy{Enter}');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('“racy” already exists. Replace it?');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(attempts).toBe(2);
    });
    expect(api.callsTo('store:generate')[1]?.force).toBe(true);
  });

  it('validates names before offering to create them', async () => {
    const { user, input } = setup();
    await user.type(input, '../escape');
    expect(await screen.findByText('Invalid name: “..” is not allowed')).toBeInTheDocument();
    expect(options()).toHaveLength(0);
    await user.keyboard('{Control>}g{/Control}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid name');
  });

  it('deletes with confirmation (Ctrl+Backspace)', async () => {
    const api = new FakeApi({ 'store:remove': () => ok(null) });
    const { user, input } = setup(api);
    await user.type(input, 'bank');
    await waitFor(() => {
      expect(options()[0]).toHaveTextContent('bank');
    });
    await user.keyboard('{Control>}{Backspace}{/Control}');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Delete “bank”?');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.callsTo('store:remove')).toHaveLength(0);
    await user.keyboard('{Control>}{Backspace}{/Control}');
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => {
      expect(api.callsTo('store:remove')).toEqual([{ path: 'bank', recursive: false }]);
    });
  });

  it('Escape clears the query, then hides the window', async () => {
    const { api, user, input } = setup();
    await user.type(input, 'abc');
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(api.callsTo('app:hideLauncher')).toHaveLength(1);
    });
  });

  it('drops decrypted state when the app locks', async () => {
    const api = new FakeApi({
      'store:show': ({ path }) =>
        ok({
          path,
          password: asPlainSecret('pw'),
          raw: asPlainSecret('pw\n'),
          fields: [],
          notes: 'secret note',
          login: null,
          url: null,
          hasOtp: false,
        }),
    });
    const { user, input } = setup(api);
    await user.type(input, 'bank{Tab}');
    expect(await screen.findByText('secret note')).toBeInTheDocument();
    act(() => {
      api.emit('app:lock', null);
    });
    await waitFor(() => {
      expect(screen.queryByText('secret note')).not.toBeInTheDocument();
    });
    expect(input).toHaveValue('');
  });

  it('virtualises very large stores', async () => {
    const api = new FakeApi();
    const many = Array.from({ length: 6000 }, (_, index) => p(`site${String(index)}`));
    api.handlers['store:list'] = () => ok({ entries: many, folders: [] });
    renderWith(api, <Launcher settings={SETTINGS} mac={false} />);
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    });
    // Only the rows in view are in the DOM.
    expect(options().length).toBeLessThan(100);
  });

  it('renders in French', async () => {
    const api = new FakeApi();
    api.handlers['store:list'] = () => ok({ entries: [], folders: [] });
    renderWith(api, <Launcher settings={SETTINGS} mac={false} />, 'fr');
    expect(
      await screen.findByText('Aucun mot de passe. Tapez un nom pour en créer un.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveAttribute(
      'placeholder',
      'Rechercher ou créer un mot de passe…',
    );
  });
});
