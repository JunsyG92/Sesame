import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GrepMatch } from '../../shared/schemas';
import type { Notify } from '../components/entry';
import { Button, Field, inputClass } from '../components/ui';
import { errorMessage } from '../i18n';
import { useApi } from '../lib/api';
import { useJob } from '../lib/jobs';

/** `pass grep`: on-demand search in decrypted contents, with progress and cancellation. */
export function Grep({ notify }: { notify: Notify }) {
  const api = useApi();
  const { t } = useTranslation();
  const job = useJob();
  const [pattern, setPattern] = useState('');
  const [regex, setRegex] = useState(false);
  const [running, setRunning] = useState(false);
  const [matches, setMatches] = useState<GrepMatch[] | null>(null);

  const run = async (): Promise<void> => {
    const id = job.start();
    setRunning(true);
    setMatches(null);
    const result = await api.invoke('store:grep', { id, pattern, regex });
    setRunning(false);
    if (result.ok) setMatches(result.value);
    else if (result.error.kind !== 'cancelled') notify('error', errorMessage(t, result.error));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
      <h2 className="text-lg font-semibold">{t('grep.title')}</h2>
      <p className="text-sm text-zinc-500">{t('grep.help')}</p>
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (pattern !== '' && !running) void run();
        }}
      >
        <div className="flex-1">
          <Field label={t('grep.pattern')}>
            <input
              className={inputClass}
              value={pattern}
              onChange={(event) => {
                setPattern(event.target.value);
              }}
            />
          </Field>
        </div>
        <label className="flex items-center gap-1 pb-2 text-sm">
          <input
            type="checkbox"
            checked={regex}
            className="accent-amber-600"
            onChange={(event) => {
              setRegex(event.target.checked);
            }}
          />
          {t('grep.regex')}
        </label>
        {running ? (
          <Button tone="danger" onClick={() => void api.invoke('store:cancelJob', { id: job.id })}>
            {t('grep.cancel')}
          </Button>
        ) : (
          <Button tone="primary" type="submit" disabled={pattern === ''}>
            {t('grep.run')}
          </Button>
        )}
      </form>
      {running && job.progress !== null ? (
        <progress
          className="w-full accent-amber-600"
          max={job.progress.total}
          value={job.progress.done}
          aria-label={t('grep.progress', job.progress)}
        />
      ) : null}
      {matches === null ? null : matches.length === 0 ? (
        <p className="text-sm text-zinc-500">{t('grep.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {matches.map((match) => (
            <li
              key={match.path}
              className="rounded border border-zinc-200 p-2 dark:border-zinc-700"
            >
              <div className="text-sm font-medium">{match.path}</div>
              {match.lines.map((line) => (
                <div key={line.line} className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
                  {String(line.line)}: {line.masked ? <em>{t('grep.masked')}</em> : line.text}
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
