/** Conversion between DOM keyboard events and Electron accelerators. */
export interface KeyStroke {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

const MODIFIERS = ['Control', 'Command', 'Alt', 'Shift', 'Super'];
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter !== undefined) return letter;
  const digit = /^Digit(\d)$/.exec(code)?.[1];
  if (digit !== undefined) return digit;
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
  return NAMED_KEYS[code] ?? null;
}

/**
 * Builds an Electron accelerator from a key press. Returns null while only
 * modifiers are held, or when no modifier is used (a global shortcut on a bare
 * key would hijack normal typing).
 */
export function acceleratorFromKeyStroke(stroke: KeyStroke, mac: boolean): string | null {
  const key = keyName(stroke.code);
  if (key === null) return null;
  const modifiers = [
    ...(stroke.ctrlKey ? ['Control'] : []),
    ...(stroke.metaKey ? [mac ? 'Command' : 'Super'] : []),
    ...(stroke.altKey ? ['Alt'] : []),
    ...(stroke.shiftKey ? ['Shift'] : []),
  ];
  const strongModifier = stroke.ctrlKey || stroke.metaKey || stroke.altKey;
  if (!strongModifier && !/^F\d+$/.test(key)) return null;
  return [...modifiers, key].join('+');
}

export function isValidAccelerator(accelerator: string): boolean {
  const parts = accelerator.split('+');
  const key = parts.at(-1) ?? '';
  const modifiers = parts.slice(0, -1);
  if (key === '' || MODIFIERS.includes(key)) return false;
  if (new Set(modifiers).size !== modifiers.length) return false;
  if (!modifiers.every((modifier) => MODIFIERS.includes(modifier))) return false;
  const known =
    /^[A-Z0-9]$/.test(key) ||
    /^F([1-9]|1\d|2[0-4])$/.test(key) ||
    Object.values(NAMED_KEYS).includes(key);
  const strongModifier = modifiers.some((modifier) => modifier !== 'Shift');
  return known && (strongModifier || /^F\d+$/.test(key));
}

/** Human-readable form (`⌘⇧Space` on macOS, `Ctrl+Shift+Space` elsewhere). */
export function formatAccelerator(accelerator: string, mac: boolean): string {
  const symbols: Readonly<Record<string, string>> = mac
    ? { Control: '⌃', Command: '⌘', Alt: '⌥', Shift: '⇧', Super: '⌘' }
    : { Control: 'Ctrl', Command: 'Cmd', Alt: 'Alt', Shift: 'Shift', Super: 'Super' };
  const parts = accelerator.split('+').map((part) => symbols[part] ?? part);
  return mac ? parts.join('') : parts.join('+');
}
