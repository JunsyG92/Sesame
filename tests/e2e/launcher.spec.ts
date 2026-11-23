import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createRequire } from 'node:module';
import { asPlainSecret, ROOT_FOLDER } from '../../src/shared/types';
import { createSandbox, entry, keyId, unwrap, type Sandbox } from '../helpers/gpgEnv';

const MAIN = path.resolve('out/main/index.js');
// The `electron` package exports the path of its binary when required from Node.js.
const electronBinary: unknown = createRequire(import.meta.url)('electron');
const executable = typeof electronBinary === 'string' ? electronBinary : '';
// Chromium refuses to run as root with its OS sandbox (CI containers).
const ARGS = process.getuid?.() === 0 ? ['--no-sandbox', MAIN] : [MAIN];

/** Main-process view of the clipboard (text + concealment hint). */
async function clipboardState(
  app: ElectronApplication,
): Promise<{ text: string; concealed: boolean }> {
  return app.evaluate(async ({ clipboard }) => {
    const formats: Record<string, string> = {
      linux: 'x-kde-passwordManagerHint',
      darwin: 'org.nspasteboard.ConcealedType',
      win32: 'ExcludeClipboardContentFromMonitorProcessing',
    };
    const format = formats[process.platform] ?? '';
    const text = await clipboard.readText();
    const concealed = await clipboard.has(`electron application/osclipboard;format="${format}"`);
    return { text, concealed };
  });
}

function toEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) result[key] = value;
  return result;
}

async function launcherVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some(
      (window) => window.webContents.getURL().includes('/launcher/') && window.isVisible(),
    ),
  );
}

async function launcherPage(app: ElectronApplication): Promise<Page> {
  await expect
    .poll(() => app.windows().some((page) => page.url().includes('/launcher/')))
    .toBe(true);
  const page = app.windows().find((candidate) => candidate.url().includes('/launcher/'));
  if (page === undefined) throw new Error('launcher window not found');
  await page.waitForLoadState('domcontentloaded');
  return page;
}

test.describe('launcher', () => {
  let sandbox: Sandbox;
  let app: ElectronApplication;
  let env: Record<string, string>;

  test.beforeAll(async () => {
    sandbox = await createSandbox();
    const key = await sandbox.newKey('E2E');
    unwrap(await sandbox.store.init(ROOT_FOLDER, [keyId(key)]));
    unwrap(await sandbox.store.gitInit());
    unwrap(
      await sandbox.store.insert(
        entry('web/existing'),
        asPlainSecret('existing-pw\nlogin: someone'),
        {
          force: false,
          kind: 'given',
        },
      ),
    );
    env = toEnv({
      ...process.env,
      ...sandbox.env,
      PASSWORD_STORE_DIR: sandbox.storeDir,
      SESAME_USER_DATA: path.join(sandbox.root, 'user-data'),
      SESAME_E2E: '1',
      ELECTRON_ENABLE_LOGGING: '0',
    });
    // NODE_OPTIONS is disabled by the hardened fuses in packaged builds; keep dev runs quiet too.
    delete env.NODE_OPTIONS;
    app = await electron.launch({ executablePath: executable, args: [...ARGS, '--toggle'], env });
  });

  test.afterAll(async () => {
    await app.close();
    await sandbox.cleanup();
  });

  test('opens on --toggle, creates a missing entry with a generated password', async () => {
    const page = await launcherPage(app);
    await expect.poll(() => launcherVisible(app)).toBe(true);
    const input = page.getByRole('combobox');
    await expect(input).toBeFocused();
    await input.fill('github');
    await expect(page.getByRole('option').first()).toContainText('github');
    await expect(page.getByRole('option').first()).toContainText(/generated|généré/);
    await input.press('Enter');
    await expect(page.getByRole('status').first()).toContainText('github');

    const stored = unwrap(await sandbox.store.show(entry('github')));
    expect(stored).toMatch(/^\S{25}\n$/);
    await expect.poll(async () => (await clipboardState(app)).text).toBe(stored.trim());
    expect((await clipboardState(app)).concealed).toBe(true);
    const log = unwrap(await sandbox.git.log(sandbox.storeDir, 1));
    expect(log[0]?.subject).toBe('Add generated password for github.');
    // The launcher hides itself shortly after a successful creation.
    await expect.poll(() => launcherVisible(app)).toBe(false);
  });

  test('a second `--toggle` invocation shows the running instance; search and copy', async () => {
    const second = spawn(executable, [...ARGS, '--toggle'], { env, stdio: 'ignore' });
    await new Promise((resolve) => second.on('exit', resolve));
    await expect.poll(() => launcherVisible(app)).toBe(true);

    const page = await launcherPage(app);
    const input = page.getByRole('combobox');
    await input.fill('githu');
    const first = page.getByRole('option').first();
    await expect(first).toHaveText(/github/);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await app.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('');
    });
    await input.press('Enter');
    const stored = unwrap(await sandbox.store.show(entry('github'))).trim();
    await expect.poll(async () => (await clipboardState(app)).text).toBe(stored);
    await expect.poll(() => launcherVisible(app)).toBe(false);

    // Shift+Enter copies the login.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/launcher/'))
        ?.show();
    });
    await input.fill('existing');
    await input.press('Shift+Enter');
    await expect.poll(async () => (await clipboardState(app)).text).toBe('someone');
  });

  test('creates a missing entry from the clipboard', async () => {
    await app.evaluate(async ({ clipboard, BrowserWindow }) => {
      await clipboard.writeText('from-the-clipboard');
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/launcher/'))
        ?.show();
    });
    const page = await launcherPage(app);
    const input = page.getByRole('combobox');
    await input.fill('bank/account');
    const clipboardItem = page.getByRole('option').nth(1);
    await expect(clipboardItem).toContainText(/clipboard|presse-papiers/);
    await input.press('ArrowDown');
    await expect(clipboardItem).toHaveAttribute('aria-selected', 'true');
    await expect(clipboardItem).toContainText('18');
    await input.press('Enter');
    await expect.poll(async () => await sandbox.store.has(entry('bank/account'))).toBe(true);
    expect(unwrap(await sandbox.store.show(entry('bank/account')))).toBe('from-the-clipboard\n');
  });

  test('Escape clears the query, then hides the launcher', async () => {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().includes('/launcher/'))
        ?.show();
    });
    const page = await launcherPage(app);
    const input = page.getByRole('combobox');
    await input.fill('something');
    await input.press('Escape');
    await expect(input).toHaveValue('');
    await input.press('Escape');
    await expect.poll(() => launcherVisible(app)).toBe(false);
  });
});
