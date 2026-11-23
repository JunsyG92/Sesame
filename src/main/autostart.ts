import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** XDG autostart entry (Linux). Windows and macOS use `app.setLoginItemSettings`. */
export function desktopEntry(executable: string): string {
  const escaped = executable.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Sesame',
    'Comment=Password manager compatible with pass',
    `Exec="${escaped}" --hidden`,
    'Icon=sesame',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function autostartFile(env: NodeJS.ProcessEnv, home: string): string {
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ''
      ? env.XDG_CONFIG_HOME
      : path.join(home, '.config');
  return path.join(configHome, 'autostart', 'sesame.desktop');
}

export async function setLinuxAutostart(
  enabled: boolean,
  env: NodeJS.ProcessEnv,
  home: string,
  executable: string,
): Promise<void> {
  const file = autostartFile(env, home);
  if (!enabled) {
    await rm(file, { force: true });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  // An AppImage is mounted at a random path: start the image file itself.
  await writeFile(file, desktopEntry(env.APPIMAGE ?? executable), 'utf8');
}
