import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OtpCode } from '../../shared/schemas';
import type { EntryPath } from '../../shared/types';
import { useApi } from '../lib/api';

/**
 * Tells the main process a secret is on screen, so the window is excluded
 * from screenshots and screen recordings while it is displayed.
 */
export function useSecretVisible(visible: boolean): void {
  const api = useApi();
  useEffect(() => {
    if (!visible) return undefined;
    void api.invoke('app:secretVisible', { visible: true });
    return () => {
      void api.invoke('app:secretVisible', { visible: false });
    };
  }, [api, visible]);
}

export function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {open ? null : <path d="M3 3l18 18" />}
    </svg>
  );
}

/** A masked secret with a reveal toggle. */
export function SecretText({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  useSecretVisible(shown);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <code className="truncate font-mono text-sm" aria-label={label}>
        {shown ? value : '•'.repeat(Math.min(16, Math.max(8, value.length)))}
      </code>
      <button
        type="button"
        className="rounded p-1 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700"
        aria-label={shown ? t('common.hide') : t('common.show')}
        aria-pressed={shown}
        onClick={() => {
          setShown((current) => !current);
        }}
      >
        <EyeIcon open={!shown} />
      </button>
    </span>
  );
}

/** Live TOTP code with countdown (pass-otp). */
export function OtpDisplay({ path, onCopy }: { path: EntryPath; onCopy: () => void }) {
  const api = useApi();
  const { t } = useTranslation();
  const [code, setCode] = useState<OtpCode | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      const result = await api.invoke('otp:code', { path });
      if (!alive || !result.ok) return;
      setCode(result.value);
      timer = setTimeout(() => void refresh(), Math.min(result.value.remaining, 1) * 1000);
    };
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, path]);
  useSecretVisible(code !== null);
  if (code === null) return null;
  const progress = (code.remaining / code.period) * 100;
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onCopy}
        className="font-mono text-xl tracking-widest text-zinc-900 hover:text-amber-600 dark:text-zinc-100"
        aria-label={`${t('entry.otp')} ${code.code}`}
      >
        {code.code.replace(/(\d{3})(?=\d)/g, '$1 ')}
      </button>
      <div
        className="h-1.5 w-24 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700"
        role="progressbar"
        aria-label={t('entry.otpRemaining', { seconds: code.remaining })}
        aria-valuemin={0}
        aria-valuemax={code.period}
        aria-valuenow={code.remaining}
      >
        <div className="h-full bg-amber-500" style={{ width: `${String(progress)}%` }} />
      </div>
      <span className="text-xs text-zinc-500">
        {t('entry.otpRemaining', { seconds: code.remaining })}
      </span>
    </div>
  );
}
