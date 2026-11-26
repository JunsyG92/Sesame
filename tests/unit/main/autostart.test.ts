import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  autostartFile,
  desktopEntry,
  launchCommand,
  setLinuxAutostart,
} from '../../../src/main/autostart';

describe('linux autostart', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'ssm-auto-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('locates the XDG autostart directory', () => {
    expect(autostartFile({}, home)).toBe(path.join(home, '.config', 'autostart', 'sesame.desktop'));
    expect(autostartFile({ XDG_CONFIG_HOME: '/xdg' }, home)).toBe(
      path.join('/xdg', 'autostart', 'sesame.desktop'),
    );
    expect(autostartFile({ XDG_CONFIG_HOME: '' }, home)).toBe(
      path.join(home, '.config', 'autostart', 'sesame.desktop'),
    );
  });

  it('writes, keeps up to date and removes the entry', async () => {
    const file = autostartFile({}, home);
    expect(await setLinuxAutostart(true, {}, home, ['/opt/Sesame/sesame'])).toBe(true);
    const content = await readFile(file, 'utf8');
    expect(content).toContain('Exec="/opt/Sesame/sesame" --hidden');
    expect(content).toContain('X-GNOME-Autostart-Delay=5');
    // Same content: nothing rewritten.
    expect(await setLinuxAutostart(true, {}, home, ['/opt/Sesame/sesame'])).toBe(false);
    // The installation moved (or was enabled from a development build): fixed on next start.
    await writeFile(file, '[Desktop Entry]\nExec="/old/electron" --hidden\n');
    expect(await setLinuxAutostart(true, {}, home, ['/opt/Sesame/sesame'])).toBe(true);
    expect(await readFile(file, 'utf8')).toContain('Exec="/opt/Sesame/sesame" --hidden');
    expect(await setLinuxAutostart(false, {}, home, ['/opt/Sesame/sesame'])).toBe(true);
    await expect(stat(file)).rejects.toThrow();
    expect(await setLinuxAutostart(false, {}, home, ['/opt/Sesame/sesame'])).toBe(false);
  });

  it('starts the right program for each kind of installation', () => {
    const base = { execPath: '/opt/Sesame/sesame', appPath: '/src/sesame', packaged: true };
    expect(launchCommand({ ...base, env: {} })).toEqual(['/opt/Sesame/sesame']);
    expect(launchCommand({ ...base, env: { APPIMAGE: '/home/me/Sesame.AppImage' } })).toEqual([
      '/home/me/Sesame.AppImage',
    ]);
    expect(launchCommand({ ...base, env: { APPIMAGE: '' } })).toEqual(['/opt/Sesame/sesame']);
    // A development build needs the application directory, not just Electron.
    expect(
      launchCommand({
        ...base,
        packaged: false,
        execPath: '/src/node_modules/electron/dist/electron',
        env: {},
      }),
    ).toEqual(['/src/node_modules/electron/dist/electron', '/src/sesame']);
  });

  it('quotes and escapes every argument', () => {
    expect(desktopEntry(['/a "b"\\c', '/my app/$HOME`x`'])).toContain(
      'Exec="/a \\"b\\"\\\\c" "/my app/\\$HOME\\`x\\`" --hidden',
    );
  });
});
