import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseInterval, ROTATION_PRESETS, type IntervalUnit } from '../../shared/rotation';
import type {
  EntryView,
  GeneratedPreview,
  GeneratorOptions,
  RotationState,
} from '../../shared/schemas';
import type { EntryPath } from '../../shared/types';
import { errorMessage } from '../i18n';
import { useApi } from '../lib/api';
import { useSettings } from '../lib/hooks';
import type { Notify } from './entry';
import { GeneratorOptionsForm } from './Generator';
import { SecretText, useSecretVisible } from './secrets';
import { Button, Field, inputClass, Modal } from './ui';

type Translate = ReturnType<typeof useTranslation>['t'];

/** "Every 2 months" */
export function intervalLabel(t: Translate, value: string): string {
  const interval = parseInterval(value);
  if (interval === null) return value;
  return t(`rotation.every.${interval.unit}`, { count: interval.count });
}

function formatDay(date: string, locale: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/** "Valid until …", "Expires in 3 days", "Expired 5 days ago"… */
export function statusLabel(
  t: Translate,
  locale: string,
  status: { dueAt: string | null; daysLeft: number | null; state: RotationState },
): string {
  if (status.dueAt === null || status.daysLeft === null) return t('rotation.status.unknown');
  if (status.state === 'ok')
    return t('rotation.status.ok', { date: formatDay(status.dueAt, locale) });
  if (status.state === 'soon') return t('rotation.status.soon', { count: status.daysLeft });
  if (status.daysLeft === 0) return t('rotation.status.expiredToday');
  return t('rotation.status.expired', { count: -status.daysLeft });
}

const UNITS: readonly IntervalUnit[] = ['d', 'w', 'm', 'y'];

const TONES: Readonly<Record<RotationState, string>> = {
  ok: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100',
  soon: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
  expired: 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100',
};

export function RotationBadge({
  status,
}: {
  status: { dueAt: string | null; daysLeft: number | null; state: RotationState };
}) {
  const { t, i18n } = useTranslation();
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${TONES[status.state]}`}>
      {status.state === 'ok' ? '✓ ' : '⚠ '}
      {statusLabel(t, i18n.language, status)}
    </span>
  );
}

/** Turn rotation on or off, choose the interval and the change page. */
export function RotationSettingsDialog({
  entry,
  notify,
  onClose,
}: {
  entry: EntryView;
  notify: Notify;
  onClose: (changed: boolean) => void;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const initial = entry.rotation.interval === null ? null : parseInterval(entry.rotation.interval);
  const [enabled, setEnabled] = useState(initial !== null);
  const initialValue = initial === null ? '2m' : `${String(initial.count)}${initial.unit}`;
  const [preset, setPreset] = useState(
    ROTATION_PRESETS.includes(initialValue) ? initialValue : 'custom',
  );
  // Kept as typed: clamping on every keystroke would turn "" then "6" into "16".
  const [count, setCount] = useState(String(initial?.count ?? 60));
  const [unit, setUnit] = useState<IntervalUnit>(initial?.unit ?? 'd');
  const [changeUrl, setChangeUrl] = useState(entry.rotation.changeUrl ?? '');
  const interval = preset === 'custom' ? `${count.trim()}${unit}` : preset;
  const urlValid = changeUrl === '' || /^https?:\/\/\S+$/i.test(changeUrl);
  const valid = urlValid && (!enabled || parseInterval(interval) !== null);

  return (
    <Modal
      title={t('rotation.configure')}
      onClose={() => {
        onClose(false);
      }}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          void api
            .invoke('rotation:configure', {
              path: entry.path,
              interval: enabled ? interval : null,
              changeUrl: changeUrl.trim(),
            })
            .then((result) => {
              if (result.ok) {
                notify('success', t('rotation.saved'));
                onClose(true);
              } else notify('error', errorMessage(t, result.error));
            });
        }}
      >
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-amber-600"
            checked={enabled}
            onChange={(event) => {
              setEnabled(event.target.checked);
            }}
          />
          {t('rotation.enable')}
        </label>
        {enabled ? (
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('rotation.interval')}>
              <select
                className={inputClass}
                value={preset}
                onChange={(event) => {
                  setPreset(event.target.value);
                }}
              >
                {ROTATION_PRESETS.map((value) => (
                  <option key={value} value={value}>
                    {intervalLabel(t, value)}
                  </option>
                ))}
                <option value="custom">{t('rotation.custom')}</option>
              </select>
            </Field>
            {preset === 'custom' ? (
              <div className="flex items-end gap-2">
                <input
                  type="number"
                  min={1}
                  max={9999}
                  aria-label={t('rotation.customCount')}
                  className={`${inputClass} w-24`}
                  value={count}
                  onChange={(event) => {
                    setCount(event.target.value);
                  }}
                />
                <select
                  aria-label={t('rotation.custom')}
                  className={inputClass}
                  value={unit}
                  onChange={(event) => {
                    const next = UNITS.find((value) => value === event.target.value);
                    if (next !== undefined) setUnit(next);
                  }}
                >
                  {UNITS.map((value) => (
                    <option key={value} value={value}>
                      {t(`rotation.units.${value}`)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        ) : null}
        <Field
          label={t('rotation.changeUrl')}
          help={urlValid ? t('rotation.changeUrlHelp') : t('rotation.invalidUrl')}
        >
          <input
            className={inputClass}
            value={changeUrl}
            placeholder="https://"
            aria-invalid={!urlValid}
            onChange={(event) => {
              setChangeUrl(event.target.value);
            }}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              onClose(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button tone="primary" type="submit" disabled={!valid}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Guided renewal: open the change page, copy the current password, copy a new
 * random one, and only then save it. Until the user confirms, the entry keeps
 * the current password, so a failed change on the site never loses it.
 */
export function RenewDialog({
  path,
  notify,
  onClose,
}: {
  path: EntryPath;
  notify: Notify;
  onClose: (renewed: boolean) => void;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const settings = useSettings();
  const [options, setOptions] = useState<GeneratorOptions | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [generated, setGenerated] = useState<GeneratedPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const effective = options ?? settings?.generator ?? null;
  useSecretVisible(generated !== null);

  useEffect(() => {
    if (effective === null) return undefined;
    let alive = true;
    void api.invoke('generator:preview', effective).then((result) => {
      if (alive && result.ok) setGenerated(result.value);
    });
    return () => {
      alive = false;
    };
  }, [api, effective]);

  const regenerate = (): void => {
    if (effective === null) return;
    void api.invoke('generator:preview', effective).then((result) => {
      if (result.ok) setGenerated(result.value);
    });
  };
  const report = (
    result: { ok: true } | { ok: false; error: Parameters<typeof errorMessage>[1] },
  ): void => {
    if (!result.ok) notify('error', errorMessage(t, result.error));
  };

  return (
    <Modal
      title={t('rotation.renewTitle', { name: path })}
      onClose={() => {
        onClose(false);
      }}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-zinc-600 dark:text-zinc-400">{t('rotation.renewIntro')}</p>
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">{t('rotation.step1')}</h3>
          <div>
            <Button
              onClick={() => void api.invoke('rotation:openChangeUrl', { path }).then(report)}
            >
              ↗ {t('rotation.openChangeUrl')}
            </Button>
          </div>
        </section>
        <section className="flex flex-col gap-1">
          <h3 className="font-medium">{t('rotation.step2')}</h3>
          <div>
            <Button
              onClick={() =>
                void api.invoke('store:copy', { path, target: { what: 'password' } }).then(report)
              }
            >
              {t('rotation.copyCurrent')}
            </Button>
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">{t('rotation.step3')}</h3>
          {generated === null ? (
            <p className="text-zinc-500">{t('common.loading')}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <SecretText value={generated.password} label={t('entry.password')} />
              <Button tone="ghost" onClick={regenerate}>
                ↻ {t('generator.regenerate')}
              </Button>
              <Button
                onClick={() =>
                  void api.invoke('clipboard:copyText', { text: generated.password }).then(report)
                }
              >
                {t('rotation.copyNew')}
              </Button>
            </div>
          )}
          <div>
            <Button
              tone="ghost"
              aria-expanded={showOptions}
              onClick={() => {
                setShowOptions((value) => !value);
              }}
            >
              {showOptions ? '▾' : '▸'} {t('rotation.options')}
            </Button>
          </div>
          {showOptions && effective !== null ? (
            <GeneratorOptionsForm options={effective} onChange={setOptions} />
          ) : null}
        </section>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              onClose(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            tone="primary"
            disabled={generated === null || busy}
            onClick={() => {
              if (generated === null) return;
              setBusy(true);
              void api
                .invoke('rotation:renew', { path, password: generated.password })
                .then((result) => {
                  setBusy(false);
                  if (result.ok) {
                    notify('success', t('rotation.renewed', { name: path }));
                    onClose(true);
                  } else notify('error', errorMessage(t, result.error));
                });
            }}
          >
            {t('rotation.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Renewal block of the entry details. */
export function RotationSection({
  entry,
  notify,
  compact,
  onChanged,
}: {
  entry: EntryView;
  notify: Notify;
  compact: boolean;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [dialog, setDialog] = useState<'settings' | 'renew' | null>(null);
  const { rotation } = entry;
  const close = (changed: boolean): void => {
    setDialog(null);
    if (changed) onChanged();
  };
  if (compact && rotation.status === null) return null;
  return (
    <section className="flex flex-col gap-2 py-2" aria-label={t('rotation.section')}>
      <span className="text-xs text-zinc-500">{t('rotation.section')}</span>
      {rotation.status === null || rotation.interval === null ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{t('rotation.none')}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <RotationBadge status={rotation.status} />
          <span className="text-zinc-600 dark:text-zinc-400">
            {intervalLabel(t, rotation.interval)}
          </span>
          {rotation.changedAt === null ? null : (
            <span className="text-xs text-zinc-500">
              {t('rotation.lastChange', { date: formatDay(rotation.changedAt, i18n.language) })}
            </span>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {rotation.status === null ? null : (
          <Button
            tone={rotation.status.state === 'ok' ? 'secondary' : 'primary'}
            onClick={() => {
              setDialog('renew');
            }}
          >
            ↻ {t('rotation.renew')}
          </Button>
        )}
        {compact ? null : (
          <Button
            onClick={() => {
              setDialog('settings');
            }}
          >
            ⏱ {t('rotation.configure')}
          </Button>
        )}
      </div>
      {dialog === 'settings' ? (
        <RotationSettingsDialog entry={entry} notify={notify} onClose={close} />
      ) : null}
      {dialog === 'renew' ? (
        <RenewDialog path={entry.path} notify={notify} onClose={close} />
      ) : null}
    </section>
  );
}
