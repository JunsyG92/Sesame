import { describe, expect, it } from 'vitest';
import {
  parseCliAction,
  ShortcutManager,
  type GlobalShortcutApi,
} from '../../../src/main/shortcuts';

class FakeGlobalShortcut implements GlobalShortcutApi {
  public readonly registered = new Set<string>();
  public constructor(
    public readonly taken = new Set<string>(),
    public readonly throwing = new Set<string>(),
  ) {}
  public register(accelerator: string): boolean {
    if (this.throwing.has(accelerator)) throw new Error('invalid');
    if (this.taken.has(accelerator) || this.registered.has(accelerator)) return false;
    this.registered.add(accelerator);
    return true;
  }
  public unregister(accelerator: string): void {
    this.registered.delete(accelerator);
  }
}

describe('ShortcutManager', () => {
  it('registers, switches and disposes the shortcut', () => {
    const api = new FakeGlobalShortcut();
    const manager = new ShortcutManager(api, () => undefined);
    expect(manager.apply('Control+Shift+Space')).toBe(true);
    expect(manager.apply('Control+Shift+Space')).toBe(true);
    expect(manager.status).toEqual({ accelerator: 'Control+Shift+Space', registered: true });
    expect(manager.apply('Alt+K')).toBe(true);
    expect([...api.registered]).toEqual(['Alt+K']);
    manager.dispose();
    expect(api.registered.size).toBe(0);
    expect(manager.status).toEqual({ accelerator: 'Alt+K', registered: false });
    manager.dispose();
  });

  it('keeps the previous shortcut when the new one conflicts', () => {
    const api = new FakeGlobalShortcut(new Set(['Alt+K']), new Set(['Alt+J']));
    const manager = new ShortcutManager(api, () => undefined);
    expect(manager.apply('Control+Shift+Space')).toBe(true);
    expect(manager.apply('Alt+K')).toBe(false);
    expect(manager.apply('Alt+J')).toBe(false);
    expect(manager.apply('Space')).toBe(false);
    expect(manager.status).toEqual({ accelerator: 'Control+Shift+Space', registered: true });
    expect([...api.registered]).toEqual(['Control+Shift+Space']);
  });

  it('reports a failure when nothing can be registered (e.g. pure Wayland)', () => {
    const api = new FakeGlobalShortcut(new Set(['Control+Shift+Space', 'Alt+K']));
    const manager = new ShortcutManager(api, () => undefined);
    expect(manager.apply('Control+Shift+Space')).toBe(false);
    expect(manager.status).toEqual({ accelerator: 'Control+Shift+Space', registered: false });
    expect(manager.apply('Alt+K')).toBe(false);
    expect(manager.status).toEqual({ accelerator: 'Alt+K', registered: false });
  });

  it('cannot restore a previous shortcut stolen in the meantime', () => {
    const api = new FakeGlobalShortcut();
    const manager = new ShortcutManager(api, () => undefined);
    manager.apply('Alt+A');
    api.taken.add('Alt+A');
    api.taken.add('Alt+B');
    expect(manager.apply('Alt+B')).toBe(false);
    expect(manager.status).toEqual({ accelerator: 'Alt+A', registered: false });
  });

  it('parses the command-line switches', () => {
    expect(parseCliAction(['sesame', '--toggle'])).toBe('toggle');
    expect(parseCliAction(['sesame', '--hidden'])).toBe('hidden');
    expect(parseCliAction(['sesame', '--manager', '--show'])).toBe('show');
    expect(parseCliAction(['sesame', '--toggled'])).toBeNull();
    expect(parseCliAction([])).toBeNull();
  });
});
