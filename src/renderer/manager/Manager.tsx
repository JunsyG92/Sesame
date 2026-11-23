import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppStatus, Settings as SettingsValue } from '../../shared/schemas';
import { Toasts } from '../components/ui';
import { useListing, useToasts } from '../lib/hooks';
import { Git } from './Git';
import { Grep } from './Grep';
import { Keys } from './Keys';
import { Onboarding } from './Onboarding';
import { Passwords } from './Passwords';
import { Settings } from './Settings';

type Tab = 'passwords' | 'grep' | 'keys' | 'git' | 'settings';
const TABS: readonly Tab[] = ['passwords', 'grep', 'keys', 'git', 'settings'];

/** The full manager window. */
export function Manager({ settings, status }: { settings: SettingsValue; status: AppStatus }) {
  const { t } = useTranslation();
  const listing = useListing();
  const { toasts, push } = useToasts();
  const [tab, setTab] = useState<Tab>('passwords');
  const needsSetup = status.gpg.path === null || !status.store.initialized;

  return (
    <div className="flex h-screen flex-col text-zinc-900 dark:text-zinc-100">
      {needsSetup && tab !== 'settings' ? (
        <main className="min-h-0 flex-1 overflow-auto">
          <Onboarding status={status} notify={push} />
        </main>
      ) : (
        <>
          <header className="flex items-center gap-1 border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
            <span className="mr-3 font-semibold text-amber-600">Sesame</span>
            <nav className="flex gap-1" aria-label={t('manager.title')}>
              {TABS.map((name) => (
                <button
                  key={name}
                  type="button"
                  aria-current={tab === name ? 'page' : undefined}
                  className={`rounded px-3 py-1 text-sm ${tab === name ? 'bg-zinc-200 font-medium dark:bg-zinc-700' : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
                  onClick={() => {
                    setTab(name);
                  }}
                >
                  {t(`manager.nav.${name}`)}
                </button>
              ))}
            </nav>
            <span className="ml-auto text-xs text-zinc-500">
              {t('manager.entries', { count: listing.entries.length })}
            </span>
          </header>
          <main className="flex min-h-0 flex-1 flex-col">
            {tab === 'passwords' ? (
              <Passwords listing={listing} settings={settings} notify={push} />
            ) : null}
            {tab === 'grep' ? <Grep notify={push} /> : null}
            {tab === 'keys' ? <Keys folders={listing.folders} notify={push} /> : null}
            {tab === 'git' ? <Git notify={push} /> : null}
            {tab === 'settings' ? (
              <Settings settings={settings} status={status} notify={push} />
            ) : null}
          </main>
        </>
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}
