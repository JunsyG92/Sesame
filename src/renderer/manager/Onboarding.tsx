import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAccelerator } from '../../shared/accelerator';
import type { AppStatus } from '../../shared/schemas';
import { GpgKeyIdSchema, ROOT_FOLDER } from '../../shared/types';
import type { Notify } from '../components/entry';
import { Button } from '../components/ui';
import { errorMessage } from '../i18n';
import { useApi } from '../lib/api';
import { CloneForm } from './Git';
import { KeyCreator, keyLabel, useKeys } from './Keys';

/**
 * First-run assistant: gpg detection, key creation or import, `pass init`,
 * optional `git init`, or cloning an existing store.
 */
export function Onboarding({ status, notify }: { status: AppStatus; notify: Notify }) {
  const api = useApi();
  const { t } = useTranslation();
  const { keys, reload } = useKeys(true);
  const [chosen, setChosen] = useState<string | null>(null);
  const [withGit, setWithGit] = useState(true);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const usable = keys.filter((key) => key.canEncrypt && !key.expired);
  const selected = chosen ?? usable[0]?.fingerprint ?? null;

  if (status.gpg.path === null) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-8">
        <h1 className="text-2xl font-semibold">{t('onboarding.title')}</h1>
        <h2 className="text-lg font-medium text-red-600">{t('onboarding.gpgMissing')}</h2>
        <p className="text-sm">{t(`onboarding.gpgInstall.${status.platform}`)}</p>
        <div className="flex gap-2">
          <Button tone="primary" onClick={() => void api.invoke('app:refresh')}>
            {t('onboarding.retry')}
          </Button>
          <Button
            onClick={() => {
              void api.invoke('app:chooseGpgBinary').then((result) => {
                if (result.ok && result.value !== null)
                  void api.invoke('settings:update', { gpgPath: result.value });
              });
            }}
          >
            {t('onboarding.chooseGpg')}
          </Button>
        </div>
      </div>
    );
  }

  const init = async (): Promise<void> => {
    if (selected === null) return;
    setBusy(true);
    const result = await api.invoke('store:init', {
      id: 'onboarding',
      folder: ROOT_FOLDER,
      keyIds: [GpgKeyIdSchema.parse(selected)],
    });
    if (result.ok && withGit && !status.store.isGit) {
      const git = await api.invoke('git:init');
      if (!git.ok) notify('error', errorMessage(t, git.error));
    }
    setBusy(false);
    if (result.ok)
      notify(
        'success',
        t('onboarding.ready', {
          shortcut: formatAccelerator(status.shortcut.accelerator, status.platform === 'darwin'),
        }),
      );
    else notify('error', errorMessage(t, result.error));
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 overflow-auto p-8">
      <div>
        <h1 className="text-2xl font-semibold">{t('onboarding.title')}</h1>
        <p className="text-sm text-zinc-500">{t('onboarding.intro')}</p>
      </div>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>{t('onboarding.noStore', { dir: status.store.dir })}</span>
        <Button
          tone="ghost"
          onClick={() => {
            void api.invoke('app:chooseStoreDir').then((result) => {
              if (result.ok && result.value !== null)
                void api.invoke('settings:update', { storeDir: result.value });
            });
          }}
        >
          {t('onboarding.changeDir')}
        </Button>
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t('onboarding.step1')}</h2>
        <div role="radiogroup" aria-label={t('onboarding.step1')} className="flex flex-col gap-1">
          {usable.map((key) => (
            <label key={key.fingerprint} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="key"
                className="accent-amber-600"
                checked={selected === key.fingerprint}
                onChange={() => {
                  setChosen(key.fingerprint);
                }}
              />
              {keyLabel(key)}
            </label>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setCreating((value) => !value);
            }}
          >
            {t('onboarding.createKey')}
          </Button>
          <Button
            onClick={() => {
              void api.invoke('gpg:importKey').then((result) => {
                if (result.ok) {
                  notify('success', t('keys.imported', { count: result.value.imported }));
                  reload();
                } else if (result.error.kind !== 'cancelled')
                  notify('error', errorMessage(t, result.error));
              });
            }}
          >
            {t('onboarding.importKey')}
          </Button>
        </div>
        {creating ? (
          <KeyCreator
            notify={notify}
            onCreated={(key) => {
              setCreating(false);
              setChosen(key.fingerprint);
              reload();
            }}
          />
        ) : null}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">{t('onboarding.step2')}</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-amber-600"
            checked={withGit}
            onChange={(event) => {
              setWithGit(event.target.checked);
            }}
          />
          {t('onboarding.withGit')}
        </label>
        <div>
          <Button tone="primary" disabled={selected === null || busy} onClick={() => void init()}>
            {t('onboarding.initStore')}
          </Button>
        </div>
      </section>
      <section className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
        <h2 className="font-medium">{t('onboarding.orClone')}</h2>
        <CloneForm
          notify={notify}
          onCloned={() => {
            notify('success', t('git.pulled'));
          }}
        />
      </section>
    </div>
  );
}
