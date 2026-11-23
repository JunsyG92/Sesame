import type { Locale } from '../schemas';

/** Strings used by the main process (tray menu). */
interface MainStrings {
  readonly openLauncher: string;
  readonly openManager: string;
  readonly clipboardEmpty: string;
  readonly lockNow: string;
  readonly quit: string;
  clearNow(seconds: number): string;
  clearingIn(seconds: number): string;
}

export const mainStrings: Readonly<Record<Locale, MainStrings>> = {
  en: {
    openLauncher: 'Search passwords…',
    openManager: 'Open Sesame',
    clipboardEmpty: 'Clipboard: nothing to clear',
    lockNow: 'Lock now',
    quit: 'Quit Sesame',
    clearNow: (seconds) => `Clear clipboard now (${String(seconds)} s left)`,
    clearingIn: (seconds) => `Sesame — clipboard cleared in ${String(seconds)} s`,
  },
  fr: {
    openLauncher: 'Rechercher un mot de passe…',
    openManager: 'Ouvrir Sesame',
    clipboardEmpty: 'Presse-papiers : rien à effacer',
    lockNow: 'Verrouiller maintenant',
    quit: 'Quitter Sesame',
    clearNow: (seconds) => `Effacer le presse-papiers (encore ${String(seconds)} s)`,
    clearingIn: (seconds) => `Sesame — presse-papiers effacé dans ${String(seconds)} s`,
  },
};
