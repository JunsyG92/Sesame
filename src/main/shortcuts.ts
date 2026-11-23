import { isValidAccelerator } from '../shared/accelerator';

/** Subset of Electron's `globalShortcut` used here (injectable for tests). */
export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface ShortcutStatus {
  readonly accelerator: string;
  readonly registered: boolean;
}

/**
 * Owns the global "toggle launcher" shortcut. Registration fails (returns
 * false) when another application already holds the accelerator, or on pure
 * Wayland sessions without the GlobalShortcuts portal: the `--toggle` command
 * line switch is the documented fallback.
 */
export class ShortcutManager {
  private current: ShortcutStatus = { accelerator: '', registered: false };

  public constructor(
    private readonly api: GlobalShortcutApi,
    private readonly onTrigger: () => void,
  ) {}

  public get status(): ShortcutStatus {
    return this.current;
  }

  private tryRegister(accelerator: string): boolean {
    if (!isValidAccelerator(accelerator)) return false;
    try {
      return this.api.register(accelerator, this.onTrigger);
    } catch {
      return false;
    }
  }

  /**
   * Switches to a new accelerator. On conflict the previous shortcut is
   * restored and false is returned.
   */
  public apply(accelerator: string): boolean {
    const previous = this.current;
    if (previous.registered) {
      if (previous.accelerator === accelerator) return true;
      this.api.unregister(previous.accelerator);
    }
    if (this.tryRegister(accelerator)) {
      this.current = { accelerator, registered: true };
      return true;
    }
    if (previous.registered && this.tryRegister(previous.accelerator)) {
      this.current = previous;
    } else {
      this.current = {
        accelerator: previous.registered ? previous.accelerator : accelerator,
        registered: false,
      };
    }
    return false;
  }

  public dispose(): void {
    if (this.current.registered) this.api.unregister(this.current.accelerator);
    this.current = { accelerator: this.current.accelerator, registered: false };
  }
}

export type CliAction = 'toggle' | 'show' | 'manager' | 'hidden';

/** Command-line switches understood by a first or second instance. */
export function parseCliAction(argv: readonly string[]): CliAction | null {
  const known: readonly CliAction[] = ['toggle', 'show', 'manager', 'hidden'];
  return known.find((action) => argv.includes(`--${action}`)) ?? null;
}
