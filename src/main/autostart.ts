import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Quotes one argument of a desktop-entry `Exec=` line (XDG Desktop Entry spec). */
function quoteArgument(argument: string): string {
  return `"${argument.replace(/[\\"`$]/g, (char) => `\\${char}`)}"`;
}

/**
 * XDG autostart entry (Linux). Windows and macOS use `app.setLoginItemSettings`.
 * `command` is the program and its arguments, without `--hidden`.
 */
export function desktopEntry(command: readonly string[]): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Sesame',
    'Comment=Password manager compatible with pass',
    `Exec=${[...command.map(quoteArgument), '--hidden'].join(' ')}`,
    'Icon=sesame',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    // Give the desktop time to start its tray host, or the tray icon may never appear.
    'X-GNOME-Autostart-Delay=5',
    'X-KDE-autostart-after=panel',
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

/**
 * The command that starts this very installation: the AppImage file itself (it
 * is mounted at a random path), the installed binary, or, for a development
 * build, Electron followed by the application directory.
 */
export function launchCommand(options: {
  env: NodeJS.ProcessEnv;
  execPath: string;
  packaged: boolean;
  appPath: string;
}): string[] {
  const appImage = options.env.APPIMAGE;
  if (appImage !== undefined && appImage !== '') return [appImage];
  return options.packaged ? [options.execPath] : [options.execPath, options.appPath];
}

/** Writes (or removes) the entry; returns true when the file changed. */
export async function setLinuxAutostart(
  enabled: boolean,
  env: NodeJS.ProcessEnv,
  home: string,
  command: readonly string[],
): Promise<boolean> {
  const file = autostartFile(env, home);
  const current = await readFile(file, 'utf8').catch(() => null);
  if (!enabled) {
    if (current === null) return false;
    await rm(file, { force: true });
    return true;
  }
  const next = desktopEntry(command);
  if (current === next) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, next, 'utf8');
  return true;
}
