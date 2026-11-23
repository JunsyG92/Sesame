import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { createSandbox, entry, unwrap, type Sandbox } from '../helpers/gpgEnv';

const MAIN = path.resolve('out/main/index.js');
const electronBinary: unknown = createRequire(import.meta.url)('electron');
const executable = typeof electronBinary === 'string' ? electronBinary : '';
const ARGS = process.getuid?.() === 0 ? ['--no-sandbox', MAIN] : [MAIN];

function toEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) result[key] = value;
  return result;
}

/** Definition of done #3: from nothing to a copied password, in well under 2 minutes. */
test('first run: create a key, initialise the store, create and copy "github"', async () => {
  test.setTimeout(120_000);
  const sandbox: Sandbox = await createSandbox();
  const app = await electron.launch({
    executablePath: executable,
    args: ARGS,
    env: toEnv({
      ...process.env,
      ...sandbox.env,
      PASSWORD_STORE_DIR: sandbox.storeDir,
      SESAME_USER_DATA: path.join(sandbox.root, 'user-data'),
      SESAME_E2E: '1',
      // No pinentry in CI: the key is created without a passphrase.
      SESAME_TEST_UNPROTECTED_KEYS: '1',
    }),
  });
  try {
    // An uninitialised store opens the manager on the onboarding assistant.
    await expect
      .poll(() => app.windows().some((page) => page.url().includes('/manager/')))
      .toBe(true);
    const manager = app.windows().find((page) => page.url().includes('/manager/'));
    if (manager === undefined) throw new Error('manager window missing');
    await expect(
      manager.getByRole('heading', { name: /Welcome to Sesame|Bienvenue/ }),
    ).toBeVisible();
    await manager.getByRole('button', { name: /Create a key|Créer une clé/ }).click();
    await manager.getByLabel(/Full name|Nom complet/).fill('Alice Example');
    await manager.getByLabel(/E-mail/).fill('alice@example.org');
    await manager.getByRole('button', { name: /Create a new key|Créer une nouvelle clé/ }).click();
    await expect(
      manager.getByRole('radio', { name: /Alice Example <alice@example.org>/ }),
    ).toBeChecked({ timeout: 60_000 });
    await manager.getByRole('button', { name: /Create the password store|Créer le store/ }).click();
    await expect.poll(() => sandbox.store.isInitialized()).toBe(true);
    await expect.poll(() => sandbox.store.isGitRepo()).toBe(true);

    // Shortcut (here: the --toggle equivalent), type, create with a generated password.
    await app.evaluate(async ({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['sesame', '--toggle']);
      await Promise.resolve();
    });
    await expect
      .poll(() => app.windows().some((page) => page.url().includes('/launcher/')))
      .toBe(true);
    const launcher = app.windows().find((page) => page.url().includes('/launcher/'));
    if (launcher === undefined) throw new Error('launcher window missing');
    const input = launcher.getByRole('combobox');
    await input.fill('github');
    await expect(launcher.getByRole('option').first()).toContainText(/generated|généré/);
    await input.press('Enter');
    await expect.poll(() => sandbox.store.has(entry('github'))).toBe(true);
    const password = unwrap(await sandbox.store.show(entry('github'))).trim();

    // Next shortcut: find it and copy it.
    await app.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('');
    });
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['sesame', '--toggle']);
    });
    await input.fill('github');
    await expect(launcher.getByRole('option').first()).toHaveText(/github/);
    await input.press('Enter');
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(password);
  } finally {
    await app.close();
    await sandbox.cleanup();
  }
});
