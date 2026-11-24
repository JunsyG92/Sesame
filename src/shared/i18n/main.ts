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
  readonly rotationAction: string;
  rotationExpired(count: number): string;
  rotationSoon(count: number): string;
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
    rotationAction: 'Click to renew.',
    rotationExpired: (count) =>
      count === 1 ? 'A password has expired' : `${String(count)} passwords have expired`,
    rotationSoon: (count) =>
      count === 1 ? 'A password expires soon' : `${String(count)} passwords expire soon`,
  },
  fr: {
    openLauncher: 'Rechercher un mot de passe…',
    openManager: 'Ouvrir Sesame',
    clipboardEmpty: 'Presse-papiers : rien à effacer',
    lockNow: 'Verrouiller maintenant',
    quit: 'Quitter Sesame',
    clearNow: (seconds) => `Effacer le presse-papiers (encore ${String(seconds)} s)`,
    clearingIn: (seconds) => `Sesame — presse-papiers effacé dans ${String(seconds)} s`,
    rotationAction: 'Cliquez pour le renouveler.',
    rotationExpired: (count) =>
      count === 1 ? 'Un mot de passe a expiré' : `${String(count)} mots de passe ont expiré`,
    rotationSoon: (count) =>
      count === 1
        ? 'Un mot de passe expire bientôt'
        : `${String(count)} mots de passe expirent bientôt`,
  },
};
