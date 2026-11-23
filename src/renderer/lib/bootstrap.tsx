import { StrictMode, useEffect, useMemo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import type { SesameApi } from '../../shared/ipc';
import type { AppStatus, Settings } from '../../shared/schemas';
import { createI18n } from '../i18n';
import { ApiProvider } from './api';
import { useSettings, useStatus, useTheme } from './hooks';
import '../styles.css';

/** Waits for settings and status, then applies theme and language. */
export function AppShell({
  children,
}: {
  children: (props: { settings: Settings; status: AppStatus }) => ReactNode;
}) {
  const settings = useSettings();
  const status = useStatus();
  useTheme(settings?.theme);
  const locale = status?.locale ?? 'en';
  const i18n = useMemo(() => createI18n(locale), [locale]);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  if (settings === null || status === null) return null;
  return <I18nextProvider i18n={i18n}>{children({ settings, status })}</I18nextProvider>;
}

export function mount(
  api: SesameApi,
  render: (props: { settings: Settings; status: AppStatus }) => ReactNode,
): void {
  const root = document.getElementById('root');
  if (root === null) throw new Error('#root missing');
  createRoot(root).render(
    <StrictMode>
      <ApiProvider api={api}>
        <AppShell>{render}</AppShell>
      </ApiProvider>
    </StrictMode>,
  );
}
