import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitCommit, GitStatus } from '../../shared/schemas';
import type { Notify } from '../components/entry';
import { Button, Field, inputClass } from '../components/ui';
import { errorMessage } from '../i18n';
import { useApi, useEvent } from '../lib/api';

/** Clone form, used here and during onboarding. */
export function CloneForm({ notify, onCloned }: { notify: Notify; onCloned: () => void }) {
  const api = useApi();
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void api.invoke('git:clone', { url }).then((result) => {
          setBusy(false);
          if (result.ok) onCloned();
          else notify('error', errorMessage(t, result.error));
        });
      }}
    >
      <div className="flex-1">
        <Field label={t('git.cloneUrl')}>
          <input
            className={inputClass}
            value={url}
            placeholder="git@github.com:me/password-store.git"
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
        </Field>
      </div>
      <Button tone="primary" type="submit" disabled={busy || url.trim() === ''}>
        {busy ? t('common.loading') : t('git.clone')}
      </Button>
    </form>
  );
}

/** `pass git`: status, pull, push, history and remote configuration. */
export function Git({ notify }: { notify: Notify }) {
  const api = useApi();
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [remote, setRemote] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void api.invoke('git:status').then((result) => {
      if (!result.ok) return;
      setStatus(result.value);
      setRemote(result.value.remote ?? '');
      if (result.value.isRepo) {
        void api.invoke('git:log', { limit: 50 }).then((history) => {
          if (history.ok) setLog(history.value);
        });
      }
    });
  }, [api]);
  useEffect(refresh, [refresh]);
  useEvent('store:changed', refresh);

  const action = async (
    channel: 'git:pull' | 'git:push' | 'git:init',
    success: string,
  ): Promise<void> => {
    setBusy(true);
    const result = await api.invoke(channel);
    setBusy(false);
    if (result.ok) notify('success', success);
    else notify('error', errorMessage(t, result.error));
    refresh();
  };

  if (status === null) return <p className="p-4 text-sm text-zinc-500">{t('common.loading')}</p>;
  if (!status.isRepo) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <h2 className="text-lg font-semibold">{t('git.title')}</h2>
        <p className="text-sm text-zinc-500">{t('git.notRepo')}</p>
        <div>
          <Button
            tone="primary"
            disabled={busy}
            onClick={() => void action('git:init', t('git.init'))}
          >
            {t('git.init')}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      <h2 className="text-lg font-semibold">{t('git.title')}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">{t('git.branch')}</dt>
        <dd>{status.branch ?? '—'}</dd>
        <dt className="text-zinc-500">{t('git.remote')}</dt>
        <dd className="truncate">{status.remote ?? t('git.noRemote')}</dd>
        <dt className="text-zinc-500">{t('git.state')}</dt>
        <dd>
          {status.ahead === 0 && status.behind === 0 ? t('git.clean') : null}
          {status.ahead > 0 ? `${t('git.ahead', { count: status.ahead })} ` : null}
          {status.behind > 0 ? t('git.behind', { count: status.behind }) : null}
          {status.changes.length > 0
            ? ` · ${t('git.changes')} (${String(status.changes.length)})`
            : null}
        </dd>
      </dl>
      <div className="flex gap-2">
        <Button
          disabled={busy || status.remote === null}
          onClick={() => void action('git:pull', t('git.pulled'))}
        >
          ⇣ {t('git.pull')}
        </Button>
        <Button
          disabled={busy || status.remote === null}
          onClick={() => void action('git:push', t('git.pushed'))}
        >
          ⇡ {t('git.push')}
        </Button>
      </div>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void api.invoke('git:setRemote', { url: remote }).then((result) => {
            if (!result.ok) notify('error', errorMessage(t, result.error));
            refresh();
          });
        }}
      >
        <div className="flex-1">
          <Field label={t('git.setRemote')}>
            <input
              className={inputClass}
              value={remote}
              onChange={(event) => {
                setRemote(event.target.value);
              }}
            />
          </Field>
        </div>
        <Button type="submit" disabled={remote.trim() === '' || remote === status.remote}>
          {t('common.save')}
        </Button>
      </form>
      <section>
        <h3 className="mb-1 text-sm font-medium">{t('git.history')}</h3>
        <ul className="flex flex-col text-xs">
          {log.map((commit) => (
            <li
              key={commit.hash}
              className="flex gap-2 border-b border-zinc-100 py-1 dark:border-zinc-800"
            >
              <code className="text-zinc-400">{commit.hash.slice(0, 7)}</code>
              <span className="flex-1 truncate">{commit.subject}</span>
              <time className="text-zinc-400" dateTime={commit.date}>
                {new Date(commit.date).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
