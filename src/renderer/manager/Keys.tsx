import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GpgKey, RecipientsInfo } from '../../shared/schemas';
import { FolderPathSchema, GpgKeyIdSchema } from '../../shared/types';
import type { Notify } from '../components/entry';
import { Button, Field, inputClass } from '../components/ui';
import { errorMessage } from '../i18n';
import { useApi } from '../lib/api';
import { useJob } from '../lib/jobs';

export function useKeys(secretOnly: boolean): { keys: GpgKey[]; reload: () => void } {
  const api = useApi();
  const [keys, setKeys] = useState<GpgKey[]>([]);
  const reload = useCallback(() => {
    void api.invoke('gpg:listKeys', { secretOnly }).then((result) => {
      if (result.ok) setKeys(result.value);
    });
  }, [api, secretOnly]);
  useEffect(reload, [reload]);
  return { keys, reload };
}

export function keyLabel(key: GpgKey): string {
  return `${key.uids[0] ?? key.keyId} (${key.fingerprint.slice(-16)})`;
}

/** Creation of an ed25519/cv25519 key; the passphrase is asked by pinentry. */
export function KeyCreator({
  notify,
  onCreated,
}: {
  notify: Notify;
  onCreated: (key: GpgKey) => void;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void api.invoke('gpg:generateKey', { name, email }).then((result) => {
          setBusy(false);
          if (result.ok) onCreated(result.value);
          else notify('error', errorMessage(t, result.error));
        });
      }}
    >
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('keys.name')}>
          <input
            className={inputClass}
            value={name}
            required
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <Field label={t('keys.email')}>
          <input
            className={inputClass}
            type="email"
            value={email}
            required
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </Field>
      </div>
      {busy ? <p className="text-sm text-zinc-500">{t('keys.generating')}</p> : null}
      <div>
        <Button
          tone="primary"
          type="submit"
          disabled={busy || name.trim() === '' || !email.includes('@')}
        >
          {t('keys.generate')}
        </Button>
      </div>
    </form>
  );
}

/** `.gpg-id` management per folder, with re-encryption progress. */
export function Keys({ folders, notify }: { folders: readonly string[]; notify: Notify }) {
  const api = useApi();
  const { t } = useTranslation();
  const job = useJob();
  const { keys, reload } = useKeys(false);
  const [folder, setFolder] = useState('');
  const [info, setInfo] = useState<RecipientsInfo | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    void api
      .invoke('store:recipients', { folder: FolderPathSchema.parse(folder) })
      .then((result) => {
        if (!result.ok) return;
        setInfo(result.value);
        setChosen(new Set(result.value.ids));
      });
  }, [api, folder]);
  useEffect(load, [load]);

  const apply = async (ids: readonly string[]): Promise<void> => {
    const keyIds = ids.map((id) => GpgKeyIdSchema.parse(id));
    const id = job.start();
    setRunning(true);
    const result = await api.invoke('store:init', {
      id,
      folder: FolderPathSchema.parse(folder),
      keyIds,
    });
    setRunning(false);
    job.reset();
    if (result.ok) notify('success', t('keys.done', { count: result.value.reencrypted }));
    else notify('error', errorMessage(t, result.error));
    load();
  };

  const toggle = (fingerprint: string): void => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(fingerprint)) next.delete(fingerprint);
      else next.add(fingerprint);
      return next;
    });
  };
  // Recipients may be listed by key id, e-mail or fingerprint: match them loosely.
  const isChosen = (key: GpgKey): boolean =>
    chosen.has(key.fingerprint) ||
    [...chosen].some(
      (id) =>
        key.fingerprint.endsWith(id.toUpperCase()) || key.uids.some((uid) => uid.includes(id)),
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      <h2 className="text-lg font-semibold">{t('keys.title')}</h2>
      <Field label={t('keys.folder')}>
        <select
          className={inputClass}
          value={folder}
          onChange={(event) => {
            setFolder(event.target.value);
          }}
        >
          <option value="">{t('keys.root')}</option>
          {folders.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Field>
      {info === null ? null : (
        <section>
          <h3 className="text-sm font-medium">{t('keys.current')}</h3>
          {info.ids.length === 0 ? (
            <p className="text-sm text-zinc-500">{t('keys.notInitialized')}</p>
          ) : (
            <>
              <p className="text-xs text-zinc-500">
                {info.own
                  ? t('keys.own')
                  : t('keys.inherited', {
                      from:
                        info.definedIn === ''
                          ? t('keys.root')
                          : (info.definedIn ?? 'PASSWORD_STORE_KEY'),
                    })}
              </p>
              <ul className="font-mono text-xs">
                {info.ids.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t('keys.available')}</h3>
        {keys.map((key) => (
          <label key={key.fingerprint} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-amber-600"
              checked={isChosen(key)}
              disabled={!key.canEncrypt || key.expired}
              onChange={() => {
                toggle(key.fingerprint);
              }}
            />
            <span className="truncate">{keyLabel(key)}</span>
            {key.hasSecret ? (
              <span className="rounded bg-emerald-100 px-1 text-xs text-emerald-800">
                {t('keys.secret')}
              </span>
            ) : null}
            {key.expired ? (
              <span className="rounded bg-red-100 px-1 text-xs text-red-800">
                {t('keys.expired')}
              </span>
            ) : null}
            {!key.canEncrypt ? (
              <span className="rounded bg-zinc-200 px-1 text-xs">{t('keys.noEncrypt')}</span>
            ) : null}
          </label>
        ))}
      </section>
      {running ? (
        <div className="flex items-center gap-2">
          <progress
            className="flex-1 accent-amber-600"
            max={job.progress?.total ?? 1}
            value={job.progress?.done ?? 0}
            aria-label={t('keys.progress', job.progress ?? { done: 0, total: 0 })}
          />
          <Button tone="danger" onClick={() => void api.invoke('store:cancelJob', { id: job.id })}>
            {t('common.cancel')}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            tone="primary"
            disabled={chosen.size === 0}
            onClick={() => {
              const ids = keys.filter(isChosen).map((key) => key.fingerprint);
              void apply(ids.length > 0 ? ids : [...chosen]);
            }}
          >
            {t('keys.apply')}
          </Button>
          {info?.own === true && folder !== '' ? (
            <Button onClick={() => void apply([])}>{t('keys.removeOwn')}</Button>
          ) : null}
        </div>
      )}
      <section className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setCreating((value) => !value);
            }}
          >
            {t('keys.generate')}
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
            {t('keys.import')}
          </Button>
          <Button
            tone="ghost"
            onClick={() => {
              void api.invoke('gpg:reloadAgent').then((result) => {
                if (result.ok) notify('success', t('keys.agentReloaded'));
                else notify('error', errorMessage(t, result.error));
              });
            }}
          >
            {t('keys.reloadAgent')}
          </Button>
        </div>
        {creating ? (
          <KeyCreator
            notify={notify}
            onCreated={(key) => {
              setCreating(false);
              reload();
              setChosen((current) => new Set([...current, key.fingerprint]));
            }}
          />
        ) : null}
      </section>
    </div>
  );
}
