import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { describe, expect, it } from 'vitest';
import { Manager } from '../../../src/renderer/manager/Manager';
import type { IpcResult } from '../../../src/shared/ipc';
import type { EntryView, GpgKey } from '../../../src/shared/schemas';
import { asPlainSecret, EntryPathSchema } from '../../../src/shared/types';
import { FakeApi, fail, NO_ROTATION, ok, renderWith, SETTINGS, STATUS } from './fakeApi';

const p = (name: string) => EntryPathSchema.parse(name);
const KEY: GpgKey = {
  fingerprint: 'A'.repeat(40),
  keyId: 'A'.repeat(16),
  uids: ['Alice <alice@example.org>'],
  canEncrypt: true,
  hasSecret: true,
  expired: false,
  created: 1,
  expires: null,
};
const VIEW = (path: string): EntryView => ({
  path: p(path),
  password: asPlainSecret('pw'),
  raw: asPlainSecret('pw\nlogin: alice\nurl: example.org\n'),
  fields: [
    { key: 'login', value: 'alice', line: 2 },
    { key: 'url', value: 'example.org', line: 3 },
  ],
  notes: '',
  login: 'alice',
  url: 'example.org',
  hasOtp: true,
  rotation: NO_ROTATION,
});

function storeApi(extra: ConstructorParameters<typeof FakeApi>[0] = {}) {
  return new FakeApi({
    'store:list': () =>
      ok({ entries: [p('web/github'), p('web/gitlab'), p('bank')], folders: ['web'] }),
    'store:show': ({ path }) => ok(VIEW(path)),
    'otp:code': () => ok({ code: '123456', period: 30, remaining: 12 }),
    ...extra,
  });
}

describe('Manager', () => {
  it('shows the onboarding when gpg is missing', async () => {
    const api = new FakeApi({ 'app:refresh': () => ok(STATUS), 'gpg:listKeys': () => ok([]) });
    const user = userEvent.setup();
    const view = renderWith(
      api,
      <Manager settings={SETTINGS} status={{ ...STATUS, gpg: { path: null, version: null } }} />,
    );
    expect(screen.getByText('GnuPG was not found')).toBeInTheDocument();
    expect(screen.getByText(/sudo apt install gnupg/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(api.callsTo('app:refresh')).toHaveLength(1);
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('shows Windows and macOS install instructions', () => {
    const api = new FakeApi();
    renderWith(
      api,
      <Manager
        settings={SETTINGS}
        status={{ ...STATUS, platform: 'win32', gpg: { path: null, version: null } }}
      />,
    );
    expect(screen.getByText(/Gpg4win/)).toBeInTheDocument();
  });

  it('walks through key creation and store initialisation', async () => {
    let keys: GpgKey[] = [];
    const api = new FakeApi({
      'gpg:listKeys': () => ok(keys),
      'gpg:generateKey': ({ name, email }) => {
        keys = [{ ...KEY, uids: [`${name} <${email}>`] }];
        return ok(keys[0] ?? KEY);
      },
      'store:init': () => ok({ reencrypted: 0 }),
      'git:init': () => ok(null),
    });
    const user = userEvent.setup();
    renderWith(
      api,
      <Manager
        settings={SETTINGS}
        status={{
          ...STATUS,
          store: { ...STATUS.store, exists: false, initialized: false, isGit: false },
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Create the password store' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Create a key' }));
    await user.type(screen.getByLabelText('Full name'), 'Alice');
    await user.type(screen.getByLabelText('E-mail'), 'alice@example.org');
    await user.click(screen.getByRole('button', { name: 'Create a new key' }));
    expect(await screen.findByRole('radio', { name: /Alice <alice@example.org>/ })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Create the password store' }));
    await waitFor(() => {
      expect(api.callsTo('store:init')).toEqual([
        { id: 'onboarding', folder: '', keyIds: [KEY.fingerprint] },
      ]);
    });
    expect(api.callsTo('git:init')).toHaveLength(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Press Ctrl+Shift+Space');
  });

  it('lists, filters and displays entries with copyable fields, OTP and QR', async () => {
    const api = storeApi({
      'store:copy': ({ target }) =>
        ok({ what: target.what === 'line' ? 'line' : target.what, clearAfterSeconds: 45 }),
      'store:qr': () => ok({ dataUrl: 'data:image/png;base64,AAAA' }),
    });
    const user = userEvent.setup();
    const view = renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    expect(await screen.findByRole('option', { name: 'web/github' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Filter' }), 'lab');
    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(1);
    });
    await user.clear(screen.getByRole('textbox', { name: 'Filter' }));
    await user.click(screen.getByRole('button', { name: /web$/ }));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.click(screen.getByRole('option', { name: 'web/github' }));
    expect(await screen.findByRole('heading', { name: 'web/github' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /One-time code 123456/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy login' }));
    await user.click(screen.getByRole('button', { name: 'Copy url' }));
    await waitFor(() => {
      expect(api.callsTo('store:copy')).toEqual([
        { path: 'web/github', target: { what: 'login' } },
        { path: 'web/github', target: { what: 'line', line: 3 } },
      ]);
    });
    await user.click(screen.getByRole('button', { name: /One-time code QR code/ }));
    expect(await screen.findByRole('img', { name: 'One-time code QR code' })).toHaveAttribute(
      'src',
      'data:image/png;base64,AAAA',
    );
    expect(await axe(view.container)).toHaveNoViolations();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('edits with the built-in editor and generates the first line', async () => {
    const api = storeApi({
      'store:edit': () => ok(null),
      'generator:preview': () =>
        ok({ password: asPlainSecret('GENERATED'), entropyBits: 100, score: 4 }),
    });
    const user = userEvent.setup();
    renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(await screen.findByRole('option', { name: 'bank' }));
    await user.click(await screen.findByRole('button', { name: /Edit/ }));
    const editor = await screen.findByRole('textbox', { name: 'Content' });
    await user.click(screen.getByRole('button', { name: /Generate/ }));
    await waitFor(() => {
      expect(editor).toHaveValue('GENERATED\nlogin: alice\nurl: example.org\n');
    });
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo('store:edit')).toEqual([
        { path: 'bank', content: 'GENERATED\nlogin: alice\nurl: example.org\n' },
      ]);
    });
  });

  it('renames with overwrite confirmation, duplicates and deletes', async () => {
    const api = storeApi({
      'store:move': ({ force }) =>
        force ? ok(null) : fail({ kind: 'entry-exists', path: 'web/gitlab' }),
      'store:duplicate': () => ok(null),
      'store:remove': () => ok(null),
    });
    const user = userEvent.setup();
    renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(await screen.findByRole('option', { name: 'web/github' }));
    await user.click(await screen.findByRole('button', { name: 'Rename / move' }));
    const name = screen.getByLabelText('New name');
    await user.clear(name);
    await user.type(name, 'web/gitlab{Enter}');
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Confirm' }),
    );
    await waitFor(() => {
      expect(api.callsTo('store:move')).toEqual([
        { from: 'web/github', to: 'web/gitlab', force: false },
        { from: 'web/github', to: 'web/gitlab', force: true },
      ]);
    });
    await user.click(await screen.findByRole('button', { name: 'Duplicate' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.callsTo('store:duplicate')).toEqual([
        { from: 'web/gitlab', to: 'web/gitlab-copy', force: false },
      ]);
    });
    // The main process pushes the new listing after every change.
    act(() => {
      api.emit('store:changed', {
        entries: [p('web/gitlab'), p('web/gitlab-copy'), p('bank')],
        folders: ['web'],
      });
    });
    await user.click(await screen.findByRole('button', { name: /Delete/ }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => {
      expect(api.callsTo('store:remove')).toEqual([{ path: 'web/gitlab-copy', recursive: false }]);
    });
  });

  it('moves an entry to a folder by drag and drop, and deletes a folder', async () => {
    const api = storeApi({ 'store:move': () => ok(null), 'store:remove': () => ok(null) });
    const user = userEvent.setup();
    renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    const entry = await screen.findByRole('option', { name: 'bank' });
    const folder = screen.getByRole('button', { name: /web$/ });
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      get types() {
        return [...data.keys()];
      },
      effectAllowed: 'all',
    };
    fireEvent.dragStart(entry, { dataTransfer });
    fireEvent.dragOver(folder, { dataTransfer });
    fireEvent.drop(folder, { dataTransfer });
    await waitFor(() => {
      expect(api.callsTo('store:move')).toEqual([{ from: 'bank', to: 'web/bank', force: false }]);
    });
    await user.click(folder);
    await user.click(screen.getByRole('button', { name: /🗑 web/ }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => {
      expect(api.callsTo('store:remove')).toEqual([{ path: 'web', recursive: true }]);
    });
  });

  it('creates an entry in the selected folder', async () => {
    const api = storeApi({ 'store:insert': () => ok(null) });
    const user = userEvent.setup();
    renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(await screen.findByRole('button', { name: /web$/ }));
    await user.click(screen.getByRole('button', { name: 'New password' }));
    const dialog = await screen.findByRole('dialog', { name: 'New password' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('web/');
    await user.type(within(dialog).getByLabelText('Name'), 'forum');
    await user.type(within(dialog).getByLabelText('Password'), 'secret');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(api.callsTo('store:insert')).toEqual([
        { path: 'web/forum', content: 'secret\n', kind: 'given', force: false, copy: false },
      ]);
    });
  });

  it('greps contents with progress and masked password lines', async () => {
    let resolveGrep: (value: IpcResult<'store:grep'>) => void = () => undefined;
    const api = storeApi({
      'store:grep': () =>
        new Promise<IpcResult<'store:grep'>>((resolve) => {
          resolveGrep = resolve;
        }),
      'store:cancelJob': () => ok(null),
    });
    const user = userEvent.setup();
    renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(screen.getByRole('button', { name: 'Search contents' }));
    await user.type(screen.getByLabelText('Text to find'), 'alice');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const id = api.callsTo('store:grep')[0]?.id ?? '';
    act(() => {
      api.emit('job:progress', { id, done: 1, total: 3 });
    });
    expect(await screen.findByRole('progressbar', { name: '1 / 3 decrypted' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.callsTo('store:cancelJob')).toEqual([{ id }]);
    act(() => {
      resolveGrep(
        ok([
          {
            path: p('bank'),
            lines: [
              { line: 1, text: '', masked: true },
              { line: 2, text: 'login: alice', masked: false },
            ],
          },
        ]),
      );
    });
    expect(await screen.findByText('match in the password line')).toBeInTheDocument();
    expect(screen.getByText(/login: alice/)).toBeInTheDocument();
  });

  it('manages recipients and re-encrypts', async () => {
    const api = storeApi({
      'gpg:listKeys': () =>
        ok([
          KEY,
          {
            ...KEY,
            fingerprint: 'B'.repeat(40),
            uids: ['Bob <bob@example.org>'],
            hasSecret: false,
          },
        ]),
      'store:recipients': ({ folder }) =>
        ok({ ids: [KEY.fingerprint], definedIn: '', own: folder === '' }),
      'store:init': () => ok({ reencrypted: 3 }),
      'gpg:reloadAgent': () => ok(null),
    });
    const user = userEvent.setup();
    renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(screen.getByRole('button', { name: 'Keys & recipients' }));
    expect(await screen.findByText('Defined in this folder')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Folder'), 'web');
    expect(await screen.findByText('Inherited from “Whole store”')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Bob/ }));
    await user.click(screen.getByRole('button', { name: 'Apply and re-encrypt' }));
    await waitFor(() => {
      expect(api.callsTo('store:init')[0]).toMatchObject({
        folder: 'web',
        keyIds: [KEY.fingerprint, 'B'.repeat(40)],
      });
    });
    expect(await screen.findByRole('status')).toHaveTextContent('3 entries re-encrypted');
    await user.click(screen.getByRole('button', { name: /Forget cached passphrases/ }));
    expect(api.callsTo('gpg:reloadAgent')).toHaveLength(1);
  });

  it('shows git status, pulls, pushes and sets the remote', async () => {
    const api = storeApi({
      'git:status': () =>
        ok({
          isRepo: true,
          branch: 'main',
          remote: 'git@example.org:me/pw.git',
          ahead: 2,
          behind: 0,
          changes: [],
        }),
      'git:log': () =>
        ok([
          {
            hash: 'abcdef1234',
            author: 'me',
            date: '2026-01-01T00:00:00Z',
            subject: 'Add given password for bank to store.',
          },
        ]),
      'git:pull': () => fail({ kind: 'git-conflict' }),
      'git:push': () => ok({ output: '' }),
      'git:setRemote': () => ok(null),
    });
    const user = userEvent.setup();
    renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(screen.getByRole('button', { name: 'Sync (git)' }));
    expect(await screen.findByText('2 commit(s) to push')).toBeInTheDocument();
    expect(screen.getByText('Add given password for bank to store.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Pull/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The remote has diverged');
    await user.click(screen.getByRole('button', { name: /Push/ }));
    await waitFor(() => {
      expect(api.callsTo('git:push')).toHaveLength(1);
    });
    const remote = screen.getByLabelText('Set remote URL');
    await user.clear(remote);
    await user.type(remote, 'https://example.org/pw.git');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.callsTo('git:setRemote')).toEqual([{ url: 'https://example.org/pw.git' }]);
  });

  it('offers git init when the store is not a repository', async () => {
    const api = storeApi({
      'git:status': () =>
        ok({ isRepo: false, branch: null, remote: null, ahead: 0, behind: 0, changes: [] }),
      'git:init': () => ok(null),
    });
    const user = userEvent.setup();
    renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(screen.getByRole('button', { name: 'Sync (git)' }));
    await user.click(await screen.findByRole('button', { name: 'Enable git history' }));
    expect(api.callsTo('git:init')).toHaveLength(1);
  });

  it('records a new global shortcut and reports conflicts', async () => {
    const api = storeApi({
      'settings:update': (patch) =>
        patch.shortcut === 'Alt+K'
          ? fail({ kind: 'shortcut-conflict', accelerator: 'Alt+K' })
          : ok(SETTINGS),
    });
    const user = userEvent.setup();
    const view = renderWith(api, <Manager settings={SETTINGS} status={STATUS} />);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const recorder = screen.getByRole('button', { name: 'Global shortcut' });
    expect(recorder).toHaveTextContent('Ctrl+Shift+Space');
    await user.click(recorder);
    expect(recorder).toHaveTextContent('Press keys…');
    await user.keyboard('{Alt>}k{/Alt}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Alt+K is already used by another application.',
    );
    await user.click(recorder);
    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}');
    await waitFor(() => {
      expect(api.callsTo('settings:update').at(-1)).toEqual({ shortcut: 'Control+Shift+P' });
    });
    await user.selectOptions(screen.getByLabelText('Language'), 'fr');
    await user.click(screen.getByRole('checkbox', { name: 'Start Sesame when I log in' }));
    await user.click(screen.getByRole('radio', { name: 'Passphrase' }));
    await user.type(screen.getByLabelText('Preset name'), 'Phrase{Enter}');
    const patches = api.callsTo('settings:update');
    expect(patches).toContainEqual({ language: 'fr' });
    expect(patches).toContainEqual({ autoStart: true });
    expect(patches).toContainEqual({
      generator: {
        mode: 'passphrase',
        words: 6,
        separator: '-',
        capitalize: false,
        addDigit: false,
      },
    });
    expect(patches.at(-1)).toEqual({ presets: [{ name: 'Phrase', options: SETTINGS.generator }] });
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('warns when the shortcut could not be registered (Wayland)', async () => {
    renderWith(
      storeApi(),
      <Manager
        settings={SETTINGS}
        status={{ ...STATUS, shortcut: { accelerator: 'Control+Shift+Space', registered: false } }}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText(/sesame --toggle/)).toBeInTheDocument();
  });
});
