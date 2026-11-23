import i18next, { type i18n as I18n } from 'i18next';
import { initReactI18next, type useTranslation } from 'react-i18next';
import type { AppError } from '../../shared/errors';
import type { PathErrorReason } from '../../shared/entryPath';
import type { Locale } from '../../shared/schemas';
import { en } from './en';
import { fr } from './fr';

export const resources = { en: { translation: en }, fr: { translation: fr } } as const;

export function createI18n(locale: Locale): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    returnObjects: true,
    initAsync: false,
  });
  return instance;
}

type Translate = ReturnType<typeof useTranslation>['t'];

export function pathReason(t: Translate, reason: PathErrorReason): string {
  return t(`pathReasons.${reason}`);
}

/** Human-readable message for a typed error (never contains secrets). */
export function errorMessage(t: Translate, error: AppError): string {
  switch (error.kind) {
    case 'invalid-path':
      return t('errors.invalid-path', { reason: pathReason(t, error.reason) });
    case 'entry-not-found':
    case 'entry-exists':
      return t(`errors.${error.kind}`, { path: error.path });
    case 'shortcut-conflict':
      return t('errors.shortcut-conflict', { accelerator: error.accelerator });
    case 'gpg-failed':
    case 'gpg-key-unusable':
    case 'git-failed':
    case 'invalid-argument':
    case 'io':
    case 'unexpected':
      return t(`errors.${error.kind}`, { message: error.message });
    case 'gpg-not-found':
    case 'gpg-no-secret-key':
    case 'gpg-cancelled':
    case 'store-missing':
    case 'store-not-initialized':
    case 'git-not-found':
    case 'not-a-git-repo':
    case 'git-no-remote':
    case 'git-conflict':
    case 'otp-missing':
    case 'otp-invalid':
    case 'qr-not-found':
    case 'clipboard-empty':
    case 'cancelled':
      return t(`errors.${error.kind}`);
  }
}
