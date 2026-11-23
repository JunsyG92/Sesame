import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { autostartFile, desktopEntry, setLinuxAutostart } from '../../../src/main/autostart';

describe('linux autostart', () => {
  it('writes and removes an XDG autostart entry', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'ssm-auto-'));
    try {
      expect(autostartFile({}, home)).toBe(
        path.join(home, '.config', 'autostart', 'sesame.desktop'),
      );
      expect(autostartFile({ XDG_CONFIG_HOME: '/xdg' }, home)).toBe(
        path.join('/xdg', 'autostart', 'sesame.desktop'),
      );
      await setLinuxAutostart(true, {}, home, '/opt/Sesame/sesame');
      const file = autostartFile({}, home);
      expect(await readFile(file, 'utf8')).toContain('Exec="/opt/Sesame/sesame" --hidden');
      await setLinuxAutostart(true, { APPIMAGE: '/home/me/Sesame.AppImage' }, home, '/tmp/x');
      expect(await readFile(file, 'utf8')).toContain('Exec="/home/me/Sesame.AppImage" --hidden');
      await setLinuxAutostart(false, {}, home, '/opt/Sesame/sesame');
      await expect(stat(file)).rejects.toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('escapes the executable path', () => {
    expect(desktopEntry('/a "b"\\c')).toContain('Exec="/a \\"b\\"\\\\c" --hidden');
  });
});
