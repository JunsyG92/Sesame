import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RotationItem } from '../../shared/schemas';
import type { EntryPath } from '../../shared/types';
import type { Notify } from '../components/entry';
import { intervalLabel, RenewDialog, RotationBadge } from '../components/rotation';
import { Button } from '../components/ui';
import { errorMessage } from '../i18n';
import { useApi } from '../lib/api';
import { useJob } from '../lib/jobs';

/** Every password set to be renewed, most urgent first. */
export function Rotation({ items, notify }: { items: readonly RotationItem[]; notify: Notify }) {
  const api = useApi();
  const { t } = useTranslation();
  const job = useJob();
  const [scanning, setScanning] = useState(false);
  const [renewing, setRenewing] = useState<EntryPath | null>(null);

  const scan = async (): Promise<void> => {
    const id = job.start();
    setScanning(true);
    const result = await api.invoke('rotation:scan', { id });
    setScanning(false);
    job.reset();
    if (result.ok) notify('success', t('rotation.scanned', result.value));
    else if (result.error.kind !== 'cancelled') notify('error', errorMessage(t, result.error));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      <h2 className="text-lg font-semibold">{t('rotation.title')}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">{t('rotation.tabEmpty')}</p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-700"
          aria-label={t('rotation.title')}
        >
          {items.map((item) => (
            <li key={item.path} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{item.path}</span>
                <span className="text-xs text-zinc-500">{intervalLabel(t, item.interval)}</span>
              </div>
              <div className="flex items-center gap-2">
                <RotationBadge status={item} />
                <Button
                  tone={item.state === 'ok' ? 'secondary' : 'primary'}
                  aria-label={`${t('rotation.renew')} ${item.path}`}
                  onClick={() => {
                    setRenewing(item.path);
                  }}
                >
                  ↻ {t('rotation.renew')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <section className="flex flex-col gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-700">
        <p className="text-xs text-zinc-500">{t('rotation.scanHelp')}</p>
        {scanning ? (
          <div className="flex items-center gap-2">
            <progress
              className="flex-1 accent-amber-600"
              max={job.progress?.total ?? 1}
              value={job.progress?.done ?? 0}
              aria-label={t('rotation.scanProgress', job.progress ?? { done: 0, total: 0 })}
            />
            <Button
              tone="danger"
              onClick={() => void api.invoke('store:cancelJob', { id: job.id })}
            >
              {t('common.cancel')}
            </Button>
          </div>
        ) : (
          <div>
            <Button onClick={() => void scan()}>⟳ {t('rotation.scan')}</Button>
          </div>
        )}
      </section>
      {renewing === null ? null : (
        <RenewDialog
          path={renewing}
          notify={notify}
          onClose={() => {
            setRenewing(null);
          }}
        />
      )}
    </div>
  );
}
