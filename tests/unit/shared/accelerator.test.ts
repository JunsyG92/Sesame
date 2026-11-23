import { describe, expect, it } from 'vitest';
import {
  acceleratorFromKeyStroke,
  formatAccelerator,
  isValidAccelerator,
  type KeyStroke,
} from '../../../src/shared/accelerator';

const stroke = (code: string, mods: Partial<KeyStroke> = {}): KeyStroke => ({
  key: '',
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('accelerators', () => {
  it('builds accelerators from key strokes', () => {
    expect(
      acceleratorFromKeyStroke(stroke('Space', { ctrlKey: true, shiftKey: true }), false),
    ).toBe('Control+Shift+Space');
    expect(acceleratorFromKeyStroke(stroke('KeyP', { metaKey: true }), true)).toBe('Command+P');
    expect(acceleratorFromKeyStroke(stroke('KeyP', { metaKey: true }), false)).toBe('Super+P');
    expect(acceleratorFromKeyStroke(stroke('Digit1', { altKey: true }), false)).toBe('Alt+1');
    expect(acceleratorFromKeyStroke(stroke('ArrowUp', { ctrlKey: true }), false)).toBe(
      'Control+Up',
    );
    expect(acceleratorFromKeyStroke(stroke('F12'), false)).toBe('F12');
    expect(acceleratorFromKeyStroke(stroke('KeyA'), false)).toBeNull();
    expect(acceleratorFromKeyStroke(stroke('KeyA', { shiftKey: true }), false)).toBeNull();
    expect(acceleratorFromKeyStroke(stroke('ControlLeft', { ctrlKey: true }), false)).toBeNull();
    expect(acceleratorFromKeyStroke(stroke('F25', { ctrlKey: true }), false)).toBeNull();
  });

  it('validates accelerators', () => {
    expect(isValidAccelerator('Control+Shift+Space')).toBe(true);
    expect(isValidAccelerator('Command+Shift+Space')).toBe(true);
    expect(isValidAccelerator('F9')).toBe(true);
    expect(isValidAccelerator('Alt+/')).toBe(true);
    expect(isValidAccelerator('Space')).toBe(false);
    expect(isValidAccelerator('Shift+A')).toBe(false);
    expect(isValidAccelerator('Control+Control+A')).toBe(false);
    expect(isValidAccelerator('Hyper+A')).toBe(false);
    expect(isValidAccelerator('Control+Shift')).toBe(false);
    expect(isValidAccelerator('Control+Foo')).toBe(false);
    expect(isValidAccelerator('')).toBe(false);
  });

  it('formats accelerators for display', () => {
    expect(formatAccelerator('Command+Shift+Space', true)).toBe('⌘⇧Space');
    expect(formatAccelerator('Control+Alt+Super+K', true)).toBe('⌃⌥⌘K');
    expect(formatAccelerator('Control+Shift+Space', false)).toBe('Ctrl+Shift+Space');
    expect(formatAccelerator('Command+Super+K', false)).toBe('Cmd+Super+K');
  });
});
