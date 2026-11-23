import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { acceleratorFromKeyStroke, formatAccelerator } from '../../shared/accelerator';
import type {
  AppStatus,
  GeneratorOptions,
  Settings as SettingsValue,
  SettingsPatch,
} from '../../shared/schemas';
import type { Notify } from '../components/entry';
import { GeneratorOptionsForm } from '../components/Generator';
import { Button, Field, inputClass } from '../components/ui';
import { errorMessage } from '../i18n';
import { useApi } from '../lib/api';

/** Records a key combination and reports conflicts with other applications. */
export function ShortcutRecorder({
  value,
  mac,
  onChange,
}: {
  value: string;
  mac: boolean;
  onChange: (accelerator: string) => void;
}) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  return (
    <button
      type="button"
      aria-label={t('settings.shortcut')}
      className={`${inputClass} text-left font-mono ${recording ? 'ring-2 ring-amber-500' : ''}`}
      onClick={() => {
        setRecording(true);
      }}
      onBlur={() => {
        setRecording(false);
      }}
      onKeyDown={(event) => {
        if (!recording) return;
        event.preventDefault();
        if (event.key === 'Escape') {
          setRecording(false);
          return;
        }
        const accelerator = acceleratorFromKeyStroke(event, mac);
        if (accelerator !== null) {
          setRecording(false);
          onChange(accelerator);
        }
      }}
    >
      {recording ? t('settings.shortcutRecording') : formatAccelerator(value, mac)}
    </button>
  );
}

export function Settings({
  settings,
  status,
  notify,
}: {
  settings: SettingsValue;
  status: AppStatus;
  notify: Notify;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const [presetName, setPresetName] = useState('');
  const mac = status.platform === 'darwin';

  const update = async (patch: SettingsPatch): Promise<void> => {
    const result = await api.invoke('settings:update', patch);
    if (result.ok) notify('success', t('settings.saved'));
    else notify('error', errorMessage(t, result.error));
  };
  const setGenerator = (generator: GeneratorOptions): void => {
    void update({ generator });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
      <h2 className="text-lg font-semibold">{t('settings.title')}</h2>
      <Field
        label={t('settings.shortcut')}
        help={
          status.shortcut.registered
            ? t('settings.shortcutHelp')
            : t('settings.shortcutUnavailable')
        }
      >
        <ShortcutRecorder
          value={settings.shortcut}
          mac={mac}
          onChange={(shortcut) => void update({ shortcut })}
        />
      </Field>

      <Field label={t('settings.store')} help={status.store.dir}>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              void api.invoke('app:chooseStoreDir').then((result) => {
                if (result.ok && result.value !== null) void update({ storeDir: result.value });
              });
            }}
          >
            {t('common.browse')}
          </Button>
          <Button
            tone="ghost"
            disabled={settings.storeDir === null}
            onClick={() => void update({ storeDir: null })}
          >
            {t('settings.storeDefault')}
          </Button>
        </div>
      </Field>

      <Field
        label={t('settings.gpg')}
        help={
          status.gpg.path === null
            ? t('errors.gpg-not-found')
            : `${status.gpg.path} (${status.gpg.version ?? '?'})`
        }
      >
        <div className="flex gap-2">
          <Button
            onClick={() => {
              void api.invoke('app:chooseGpgBinary').then((result) => {
                if (result.ok && result.value !== null) void update({ gpgPath: result.value });
              });
            }}
          >
            {t('common.browse')}
          </Button>
          <Button
            tone="ghost"
            disabled={settings.gpgPath === null}
            onClick={() => void update({ gpgPath: null })}
          >
            {t('settings.gpgAuto')}
          </Button>
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label={t('settings.clipTime')} help={t('settings.clipDefault')}>
          <input
            type="number"
            min={5}
            max={600}
            className={inputClass}
            value={settings.clipTime ?? ''}
            placeholder="45"
            onChange={(event) => {
              const value = event.target.value === '' ? null : Number(event.target.value);
              if (value === null || (value >= 5 && value <= 600)) void update({ clipTime: value });
            }}
          />
        </Field>
        <Field label={t('settings.autoLock')}>
          <input
            type="number"
            min={0}
            max={720}
            className={inputClass}
            value={settings.autoLockMinutes}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 0 && value <= 720)
                void update({ autoLockMinutes: value });
            }}
          />
        </Field>
        <Field label={t('settings.theme')}>
          <select
            className={inputClass}
            value={settings.theme}
            onChange={(event) => {
              const theme = (['system', 'light', 'dark'] as const).find(
                (value) => value === event.target.value,
              );
              if (theme !== undefined) void update({ theme });
            }}
          >
            {(['system', 'light', 'dark'] as const).map((theme) => (
              <option key={theme} value={theme}>
                {t(`settings.themes.${theme}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('settings.language')}>
          <select
            className={inputClass}
            value={settings.language}
            onChange={(event) => {
              const language = (['system', 'fr', 'en'] as const).find(
                (value) => value === event.target.value,
              );
              if (language !== undefined) void update({ language });
            }}
          >
            {(['system', 'fr', 'en'] as const).map((language) => (
              <option key={language} value={language}>
                {t(`settings.languages.${language}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {(
        [
          ['autoStart', 'settings.autoStart'],
          ['reloadAgentOnLock', 'settings.reloadAgent'],
          ['autoUpdate', 'settings.autoUpdate'],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="accent-amber-600"
            checked={settings[key]}
            onChange={(event) => void update({ [key]: event.target.checked })}
          />
          {t(label)}
        </label>
      ))}

      <section className="flex flex-col gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-700">
        <h3 className="text-sm font-medium">{t('settings.generator')}</h3>
        <GeneratorOptionsForm options={settings.generator} onChange={setGenerator} />
        <h3 className="text-sm font-medium">{t('generator.presets')}</h3>
        <div className="flex flex-wrap gap-2">
          {settings.presets.map((preset) => (
            <span
              key={preset.name}
              className="inline-flex items-center gap-1 rounded bg-zinc-200 px-2 py-1 text-xs dark:bg-zinc-700"
            >
              <button
                type="button"
                title={t('generator.makeDefault')}
                onClick={() => {
                  setGenerator(preset.options);
                }}
              >
                {preset.name}
              </button>
              <button
                type="button"
                aria-label={`${t('common.delete')} ${preset.name}`}
                onClick={() =>
                  void update({
                    presets: settings.presets.filter((item) => item.name !== preset.name),
                  })
                }
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const name = presetName.trim();
            if (name === '') return;
            void update({
              presets: [
                ...settings.presets.filter((item) => item.name !== name),
                { name, options: settings.generator },
              ].slice(-20),
            });
            setPresetName('');
          }}
        >
          <input
            className={inputClass}
            placeholder={t('generator.presetName')}
            aria-label={t('generator.presetName')}
            value={presetName}
            maxLength={40}
            onChange={(event) => {
              setPresetName(event.target.value);
            }}
          />
          <Button type="submit" disabled={presetName.trim() === ''}>
            {t('generator.savePreset')}
          </Button>
        </form>
      </section>
      <p className="text-xs text-zinc-500">
        {t('settings.about', { version: status.version, gpg: status.gpg.version ?? '—' })}
      </p>
    </div>
  );
}
