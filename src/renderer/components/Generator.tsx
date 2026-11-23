import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GeneratedPreview, GeneratorOptions } from '../../shared/schemas';
import { useApi } from '../lib/api';
import { Button, Field, inputClass } from './ui';
import { SecretText } from './secrets';

const DEFAULTS: Readonly<Record<GeneratorOptions['mode'], GeneratorOptions>> = {
  chars: {
    mode: 'chars',
    length: 25,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    excludeAmbiguous: false,
    exclude: '',
  },
  passphrase: { mode: 'passphrase', words: 6, separator: '-', capitalize: false, addDigit: false },
  pin: { mode: 'pin', length: 6 },
};

const STRENGTH_COLORS = [
  'bg-red-600',
  'bg-orange-500',
  'bg-yellow-500',
  'bg-lime-500',
  'bg-emerald-600',
];

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
      <input
        type="checkbox"
        checked={checked}
        className="accent-amber-600"
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {label}
    </label>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={`${label} (${String(value)})`}>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        className="accent-amber-600"
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
      />
    </Field>
  );
}

/** Option editor for the three generator modes. */
export function GeneratorOptionsForm({
  options,
  onChange,
}: {
  options: GeneratorOptions;
  onChange: (options: GeneratorOptions) => void;
}) {
  const { t } = useTranslation();
  const modeId = useId();
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-labelledby={modeId} className="flex gap-1">
        <span id={modeId} className="sr-only">
          {t('generator.mode')}
        </span>
        {(['chars', 'passphrase', 'pin'] as const).map((mode) => (
          <Button
            key={mode}
            role="radio"
            aria-checked={options.mode === mode}
            tone={options.mode === mode ? 'primary' : 'secondary'}
            onClick={() => {
              if (options.mode !== mode) onChange(DEFAULTS[mode]);
            }}
          >
            {t(`generator.${mode}`)}
          </Button>
        ))}
      </div>
      {options.mode === 'chars' ? (
        <>
          <NumberInput
            label={t('generator.length')}
            value={options.length}
            min={8}
            max={128}
            onChange={(length) => {
              onChange({ ...options, length });
            }}
          />
          <div className="grid grid-cols-2 gap-1">
            {(['upper', 'lower', 'digits', 'symbols'] as const).map((key) => (
              <Check
                key={key}
                label={t(`generator.${key}`)}
                checked={options[key]}
                onChange={(value) => {
                  onChange({ ...options, [key]: value });
                }}
              />
            ))}
          </div>
          <Check
            label={t('generator.excludeAmbiguous')}
            checked={options.excludeAmbiguous}
            onChange={(excludeAmbiguous) => {
              onChange({ ...options, excludeAmbiguous });
            }}
          />
          <Field label={t('generator.exclude')}>
            <input
              className={inputClass}
              value={options.exclude}
              maxLength={128}
              onChange={(event) => {
                onChange({ ...options, exclude: event.target.value });
              }}
            />
          </Field>
        </>
      ) : options.mode === 'passphrase' ? (
        <>
          <NumberInput
            label={t('generator.words')}
            value={options.words}
            min={3}
            max={12}
            onChange={(words) => {
              onChange({ ...options, words });
            }}
          />
          <Field label={t('generator.separator')}>
            <input
              className={inputClass}
              value={options.separator}
              maxLength={3}
              onChange={(event) => {
                onChange({ ...options, separator: event.target.value });
              }}
            />
          </Field>
          <Check
            label={t('generator.capitalize')}
            checked={options.capitalize}
            onChange={(capitalize) => {
              onChange({ ...options, capitalize });
            }}
          />
          <Check
            label={t('generator.addDigit')}
            checked={options.addDigit}
            onChange={(addDigit) => {
              onChange({ ...options, addDigit });
            }}
          />
        </>
      ) : (
        <NumberInput
          label={t('generator.length')}
          value={options.length}
          min={4}
          max={12}
          onChange={(length) => {
            onChange({ ...options, length });
          }}
        />
      )}
    </div>
  );
}

/** Live preview with strength meter and entropy. */
export function GeneratorPreview({ options }: { options: GeneratorOptions }) {
  const api = useApi();
  const { t } = useTranslation();
  const [preview, setPreview] = useState<GeneratedPreview | null>(null);
  const refresh = useCallback(() => {
    void api.invoke('generator:preview', options).then((result) => {
      setPreview(result.ok ? result.value : null);
    });
  }, [api, options]);
  useEffect(refresh, [refresh]);
  if (preview === null)
    return <p className="text-sm text-red-600">{t('errors.invalid-argument', { message: '∅' })}</p>;
  const strength = t(`generator.strength.${String(preview.score)}`);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <SecretText value={preview.password} label={t('entry.password')} />
        <Button tone="ghost" onClick={refresh}>
          ↻ {t('generator.regenerate')}
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        <div
          className="flex h-1.5 flex-1 gap-0.5"
          role="meter"
          aria-label={strength}
          aria-valuemin={0}
          aria-valuemax={4}
          aria-valuenow={preview.score}
        >
          {[0, 1, 2, 3, 4].map((level) => (
            <div
              key={level}
              className={`flex-1 rounded ${level <= preview.score ? (STRENGTH_COLORS[preview.score] ?? '') : 'bg-zinc-200 dark:bg-zinc-700'}`}
            />
          ))}
        </div>
        <span>{strength}</span>
        <span>· {t('generator.entropy', { bits: Math.round(preview.entropyBits) })}</span>
      </div>
    </div>
  );
}
