import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { asPlainSecret, ROOT_FOLDER } from '../../src/shared/types';
import { createSandbox, entry, keyId, unwrap, type Sandbox } from '../helpers/gpgEnv';

const MAIN = path.resolve('out/main/index.js');
const electronBinary: unknown = createRequire(import.meta.url)('electron');
const executable = typeof electronBinary === 'string' ? electronBinary : '';
const ARGS = process.getuid?.() === 0 ? ['--no-sandbox', MAIN] : [MAIN];

function toEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) result[key] = value;
  return result;
}

test('configure renewal, see it expire, renew with a random password', async () => {
  test.setTimeout(120_000);
  const sandbox: Sandbox = await createSandbox();
  const key = await sandbox.newKey('Rotation');
  unwrap(await sandbox.store.init(ROOT_FOLDER, [keyId(key)]));
  unwrap(
    await sandbox.store.insert(entry('web/github'), asPlainSecret('old-pw\nlogin: alice\n'), {
      force: false,
      kind: 'given',
    }),
  );
  // Written by `pass` on another device: rotation without a known change date.
  unwrap(
    await sandbox.store.insert(entry('bank'), asPlainSecret('bank-pw\nrotation: 3m\n'), {
      force: false,
      kind: 'given',
    }),
  );
  const app = await electron.launch({
    executablePath: executable,
    args: [...ARGS, '--manager'],
    env: toEnv({
      ...process.env,
      ...sandbox.env,
      PASSWORD_STORE_DIR: sandbox.storeDir,
      SESAME_USER_DATA: path.join(sandbox.root, 'user-data'),
      SESAME_E2E: '1',
      LANG: 'en_US.UTF-8',
    }),
  });
  try {
    await expect
      .poll(() => app.windows().some((page) => page.url().includes('/manager/')))
      .toBe(true);
    const manager = app.windows().find((page) => page.url().includes('/manager/'));
    if (manager === undefined) throw new Error('manager window missing');

    // Turn renewal on for web/github, every 2 months, with a change page.
    await manager.getByRole('option', { name: 'web/github' }).click();
    const section = manager.getByRole('region', { name: /Renewal|Renouvellement/ });
    await section
      .getByRole('button', { name: /Renewal settings|Paramètres de renouvellement/ })
      .click();
    const settings = manager.getByRole('dialog');
    await settings.getByRole('checkbox').check();
    await settings.getByRole('textbox').fill('https://github.com/settings/security');
    await settings.getByRole('button', { name: /Save|Enregistrer/ }).click();
    await expect
      .poll(async () => unwrap(await sandbox.store.show(entry('web/github'))))
      .toMatch(
        /^old-pw\nlogin: alice\nrotation: 2m\npassword-changed: \d{4}-\d{2}-\d{2}\nchange-url: https:\/\/github\.com\/settings\/security\n$/,
      );

    // The store scan finds the entry configured outside Sesame, already expired.
    await manager.getByRole('button', { name: /^(Renewal|Renouvellement)/ }).click();
    await manager.getByRole('button', { name: /Scan the store|Analyser le store/ }).click();
    const list = manager.getByRole('list');
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByRole('listitem').first()).toContainText('bank');

    // Renew it: a new random password replaces the first line only after confirmation.
    await list.getByRole('button', { name: /bank/ }).click();
    const renew = manager.getByRole('dialog');
    await renew
      .getByRole('button', { name: /The password is changed|Le mot de passe est changé/ })
      .click();
    await expect(renew).toBeHidden();
    const renewed = unwrap(await sandbox.store.show(entry('bank')));
    expect(renewed).toMatch(/^\S{25}\nrotation: 3m\npassword-changed: \d{4}-\d{2}-\d{2}\n$/);
    expect(renewed.startsWith('bank-pw')).toBe(false);
    await expect(list.getByRole('listitem').first()).not.toContainText(/Expired|Expiré/);
  } finally {
    await app.close();
    await sandbox.cleanup();
  }
});
