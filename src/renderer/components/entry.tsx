import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { validateEntryPath } from '../../shared/entryPath';
import { fieldKeyOf, isSensitiveKey } from '../../shared/sensitive';
import type { AppError } from '../../shared/errors';
import type { CopyOutcome, CopyTarget, EntryView, GeneratorOptions } from '../../shared/schemas';
import { asPlainSecret, EntryPathSchema, type EntryPath } from '../../shared/types';
import { errorMessage, pathReason } from '../i18n';
import { useApi } from '../lib/api';
import { GeneratorOptionsForm, GeneratorPreview } from './Generator';
import { RotationSection } from './rotation';
import { EyeIcon, OtpDisplay, SecretText, useSecretVisible } from './secrets';
import { Button, Field, inputClass, Modal } from './ui';

/** Renders typed text as bullets (like a password field), keeping it editable. */
export const MASKED_TEXT = '[-webkit-text-security:disc]';

export type Notify = (tone: 'info' | 'success' | 'error', text: string) => void;

/** Copies part of an entry and reports the outcome in the user's language. */
export function useCopy(notify: Notify) {
  const api = useApi();
  const { t } = useTranslation();
  return async (path: EntryPath, target: CopyTarget): Promise<CopyOutcome | null> => {
    const result = await api.invoke('store:copy', { path, target });
    if (!result.ok) {
      notify('error', errorMessage(t, result.error));
      return null;
    }
    const key = {
      password: 'launcher.copiedPassword',
      login: 'launcher.copiedLogin',
      otp: 'launcher.copiedOtp',
      line: 'launcher.copiedLine',
    }[result.value.what];
    notify('success', t(key, { seconds: result.value.clearAfterSeconds }));
    return result.value;
  };
}

/** Decrypts an entry for display; the decrypted view is dropped on unmount or lock. */
export function useEntry(path: EntryPath | null, version = 0) {
  const api = useApi();
  const key = `${path ?? ''}#${String(version)}`;
  const [state, setState] = useState<{
    key: string;
    entry: EntryView | null;
    error: AppError | null;
  }>({
    key: '',
    entry: null,
    error: null,
  });
  useEffect(() => {
    if (path === null) return undefined;
    let alive = true;
    void api.invoke('store:show', { path }).then((result) => {
      if (!alive) return;
      setState(
        result.ok
          ? { key, entry: result.value, error: null }
          : { key, entry: null, error: result.error },
      );
    });
    return () => {
      alive = false;
    };
  }, [api, path, key]);
  useEffect(
    () =>
      api.on('app:lock', () => {
        setState((current) => ({ ...current, entry: null }));
      }),
    [api],
  );
  if (path === null) return { entry: null, error: null, loading: false };
  if (state.key !== key) return { entry: null, error: null, loading: true };
  return { entry: state.entry, error: state.error, loading: false };
}

/**
 * Free-form notes often hold secrets (recovery codes, keys, a second password):
 * they stay hidden until the user asks to see them.
 */
function Notes({ notes }: { notes: string }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  useSecretVisible(shown);
  const lines = notes.split('\n').length;
  return (
    <div className="py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-500">{t('entry.notes')}</span>
        <Button
          tone="ghost"
          aria-pressed={shown}
          onClick={() => {
            setShown((value) => !value);
          }}
        >
          <EyeIcon open={!shown} /> {shown ? t('entry.hideNotes') : t('entry.showNotes')}
        </Button>
      </div>
      {shown ? (
        <pre className="font-sans text-sm whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
          {notes}
        </pre>
      ) : (
        <p className="text-sm text-zinc-500">
          <span aria-hidden="true">•••••••• </span>
          {t('entry.notesHidden', { count: lines })}
        </p>
      )}
    </div>
  );
}

function CopyRow({
  label,
  children,
  onCopy,
}: {
  label: string;
  children: ReactNode;
  onCopy: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2 border-b border-zinc-200 py-2 last:border-0 dark:border-zinc-700">
      <div className="flex min-w-0 flex-col">
        <span className="text-xs text-zinc-500">{label}</span>
        <div className="min-w-0 truncate text-sm text-zinc-900 dark:text-zinc-100">{children}</div>
      </div>
      <Button tone="ghost" aria-label={t('entry.copyField', { field: label })} onClick={onCopy}>
        {t('common.copy')}
      </Button>
    </div>
  );
}

/** Read-only view of a decrypted entry: copyable fields, notes, TOTP, QR codes. */
export function EntryDetails({
  entry,
  notify,
  compact = false,
  onChanged,
}: {
  entry: EntryView;
  notify: Notify;
  compact?: boolean;
  onChanged?: () => void;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const copy = useCopy(notify);
  const [qr, setQr] = useState<{ title: string; dataUrl: string } | null>(null);
  const [otpEditor, setOtpEditor] = useState(false);
  useSecretVisible(qr !== null);

  const showQr = async (target: 'password' | 'otp'): Promise<void> => {
    const result = await api.invoke('store:qr', { path: entry.path, target });
    if (result.ok)
      setQr({
        title: t(target === 'otp' ? 'entry.qrOtp' : 'entry.qrPassword'),
        dataUrl: result.value.dataUrl,
      });
    else notify('error', errorMessage(t, result.error));
  };
  const loginField = entry.fields.find((field) => field.value === entry.login);

  return (
    <div className="flex flex-col">
      <CopyRow
        label={t('entry.password')}
        onCopy={() => void copy(entry.path, { what: 'password' })}
      >
        <SecretText value={entry.password} label={t('entry.password')} />
      </CopyRow>
      {entry.login === null ? null : (
        <CopyRow
          label={loginField?.key ?? t('entry.login')}
          onCopy={() => void copy(entry.path, { what: 'login' })}
        >
          {entry.login}
        </CopyRow>
      )}
      {entry.fields
        .filter((field) => field !== loginField)
        .map((field) => (
          <CopyRow
            key={field.line}
            label={field.key}
            onCopy={() => void copy(entry.path, { what: 'line', line: field.line })}
          >
            {isSensitiveKey(field.key) ? (
              <SecretText value={field.value} label={field.key} />
            ) : (
              field.value
            )}
          </CopyRow>
        ))}
      {entry.url === null ? null : (
        <div className="py-2">
          <Button
            tone="ghost"
            onClick={() => {
              void api.invoke('store:openUrl', { path: entry.path }).then((result) => {
                if (!result.ok) notify('error', errorMessage(t, result.error));
              });
            }}
          >
            ↗ {t('entry.openUrl')}
          </Button>
        </div>
      )}
      {entry.hasOtp ? (
        <div className="py-2">
          <span className="text-xs text-zinc-500">{t('entry.otp')}</span>
          <OtpDisplay path={entry.path} onCopy={() => void copy(entry.path, { what: 'otp' })} />
        </div>
      ) : null}
      <RotationSection
        entry={entry}
        notify={notify}
        compact={compact}
        onChanged={() => {
          onChanged?.();
        }}
      />
      {entry.notes === '' ? null : <Notes notes={entry.notes} />}
      {compact ? null : (
        <div className="flex flex-wrap gap-2 pt-3">
          <Button onClick={() => void showQr('password')}>▦ {t('entry.qrPassword')}</Button>
          {entry.hasOtp ? (
            <Button onClick={() => void showQr('otp')}>▦ {t('entry.qrOtp')}</Button>
          ) : null}
          <Button
            onClick={() => {
              setOtpEditor(true);
            }}
          >
            + {t('entry.addOtp')}
          </Button>
        </div>
      )}
      {qr === null ? null : (
        <Modal
          title={qr.title}
          onClose={() => {
            setQr(null);
          }}
        >
          <img src={qr.dataUrl} alt={qr.title} className="mx-auto h-64 w-64 bg-white p-2" />
          <div className="mt-3 flex justify-end">
            <Button
              autoFocus
              onClick={() => {
                setQr(null);
              }}
            >
              {t('common.close')}
            </Button>
          </div>
        </Modal>
      )}
      {otpEditor ? (
        <OtpEditor
          path={entry.path}
          notify={notify}
          onClose={(changed) => {
            setOtpEditor(false);
            if (changed) onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

function OtpEditor({
  path,
  notify,
  onClose,
}: {
  path: EntryPath;
  notify: Notify;
  onClose: (changed: boolean) => void;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const [uri, setUri] = useState('');
  const finish = (result: { ok: true } | { ok: false; error: AppError }): void => {
    if (result.ok) {
      notify('success', t('entry.saved'));
      onClose(true);
    } else if (result.error.kind !== 'cancelled') notify('error', errorMessage(t, result.error));
  };
  return (
    <Modal
      title={t('entry.addOtp')}
      onClose={() => {
        onClose(false);
      }}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void api.invoke('otp:setUri', { path, uri: asPlainSecret(uri) }).then(finish);
        }}
      >
        <Field label={t('entry.otpUri')}>
          <input
            autoFocus
            className={inputClass}
            value={uri}
            placeholder="otpauth://totp/…"
            onChange={(event) => {
              setUri(event.target.value);
            }}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void api.invoke('otp:importImage', { path }).then(finish)}>
            {t('entry.importQrImage')}
          </Button>
          <Button onClick={() => void api.invoke('otp:importScreen', { path }).then(finish)}>
            {t('entry.importQrScreen')}
          </Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              onClose(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button tone="primary" type="submit" disabled={uri.trim() === ''}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Built-in multi-line editor (replaces `pass edit` and its external $EDITOR). */
export function EntryEditor({
  entry,
  generator,
  notify,
  onDone,
}: {
  entry: EntryView;
  generator: GeneratorOptions;
  notify: Notify;
  onDone: (saved: boolean) => void;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const id = useId();
  const [content, setContent] = useState<string>(entry.raw);
  // Multi-line content is masked like a password field until the user reveals it.
  const [revealed, setRevealed] = useState(false);
  const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
  const firstLineKey = content.includes('\n') ? fieldKeyOf(firstLine) : null;
  useSecretVisible(true);
  const generateFirstLine = async (): Promise<void> => {
    const result = await api.invoke('generator:preview', generator);
    if (!result.ok) return;
    const index = content.indexOf('\n');
    setContent(index === -1 ? result.value.password : result.value.password + content.slice(index));
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- only handles Escape and Ctrl+Enter; controls inside are focusable
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void api
          .invoke('store:edit', { path: entry.path, content: asPlainSecret(content) })
          .then((result) => {
            if (result.ok) {
              notify('success', t('entry.saved'));
              onDone(true);
            } else notify('error', errorMessage(t, result.error));
          });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onDone(false);
        }
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          event.currentTarget.requestSubmit();
        }
      }}
    >
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          {t('entry.content')}
        </label>
        <div className="flex gap-1">
          <Button
            tone="ghost"
            aria-pressed={revealed}
            onClick={() => {
              setRevealed((value) => !value);
            }}
          >
            <EyeIcon open={!revealed} />{' '}
            {revealed ? t('entry.hideContent') : t('entry.showContent')}
          </Button>
          <Button tone="ghost" onClick={() => void generateFirstLine()}>
            ⚄ {t('entry.generate')}
          </Button>
        </div>
      </div>
      <textarea
        id={id}
        autoFocus
        spellCheck={false}
        autoComplete="off"
        data-masked={!revealed}
        className={`${inputClass} min-h-40 font-mono ${revealed ? '' : MASKED_TEXT}`}
        value={content}
        onChange={(event) => {
          setContent(event.target.value);
        }}
      />
      {firstLineKey === null ? null : (
        <span role="alert" className="text-xs text-amber-700 dark:text-amber-400">
          {t('entry.firstLineWarning', { key: firstLineKey })}
        </span>
      )}
      <span className="text-xs text-zinc-500">{t('entry.contentHelp')}</span>
      <div className="flex justify-end gap-2">
        <Button
          onClick={() => {
            onDone(false);
          }}
        >
          {t('common.cancel')}
        </Button>
        <Button tone="primary" type="submit">
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** Live validation of a name typed by the user. */
export function useNameValidation(name: string): { path: EntryPath | null; error: string | null } {
  const { t } = useTranslation();
  const validated = validateEntryPath(name, 'new');
  if (!validated.ok) {
    return {
      path: null,
      error:
        name.trim() === ''
          ? null
          : t('launcher.invalidName', { reason: pathReason(t, validated.error) }),
    };
  }
  return { path: EntryPathSchema.parse(validated.value), error: null };
}

export interface CreateDraft {
  readonly password: string;
  readonly login: string;
  readonly url: string;
  readonly notes: string;
}

export function draftToContent(draft: CreateDraft): string {
  const lines = [draft.password];
  if (draft.login.trim() !== '') lines.push(`login: ${draft.login.trim()}`);
  if (draft.url.trim() !== '') lines.push(`url: ${draft.url.trim()}`);
  if (draft.notes.trim() !== '') lines.push(draft.notes.trim());
  return `${lines.join('\n')}\n`;
}

/** `pass insert [--multiline]` as a form: password, login, URL and notes. */
export function CreateForm({
  initialName,
  generator,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  generator: GeneratorOptions;
  onSubmit: (path: EntryPath, content: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [name, setName] = useState(initialName);
  const [draft, setDraft] = useState<CreateDraft>({ password: '', login: '', url: '', notes: '' });
  const [shown, setShown] = useState(false);
  const validation = useNameValidation(name);
  useSecretVisible(shown);
  const set = (key: keyof CreateDraft) => (event: { target: { value: string } }) => {
    setDraft((current) => ({ ...current, [key]: event.target.value }));
  };
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- only handles Escape; every control inside is natively focusable
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (validation.path !== null && draft.password !== '')
          onSubmit(validation.path, draftToContent(draft));
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <Field label={t('create.name')} help={validation.error ?? t('create.nameHelp')}>
        <input
          className={inputClass}
          value={name}
          aria-invalid={validation.error !== null}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
      <Field label={t('create.password')}>
        <div className="flex gap-1">
          <input
            autoFocus
            type={shown ? 'text' : 'password'}
            autoComplete="off"
            className={inputClass}
            value={draft.password}
            onChange={set('password')}
          />
          <Button
            tone="ghost"
            aria-label={shown ? t('common.hide') : t('common.show')}
            aria-pressed={shown}
            onClick={() => {
              setShown((value) => !value);
            }}
          >
            {shown ? t('common.hide') : t('common.show')}
          </Button>
          <Button
            tone="ghost"
            onClick={() => {
              void api.invoke('generator:preview', generator).then((result) => {
                if (result.ok)
                  setDraft((current) => ({ ...current, password: result.value.password }));
              });
            }}
          >
            ⚄ {t('entry.generate')}
          </Button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t('create.login')}>
          <input className={inputClass} value={draft.login} onChange={set('login')} />
        </Field>
        <Field label={t('create.url')}>
          <input className={inputClass} value={draft.url} onChange={set('url')} />
        </Field>
      </div>
      <Field label={t('create.notes')}>
        <textarea
          className={`${inputClass} min-h-16 ${shown ? '' : MASKED_TEXT}`}
          data-masked={!shown}
          autoComplete="off"
          spellCheck={false}
          value={draft.notes}
          onChange={set('notes')}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button
          tone="primary"
          type="submit"
          disabled={validation.path === null || draft.password === ''}
        >
          {t('create.create')}
        </Button>
      </div>
    </form>
  );
}

/** Generator with options, used before saving a generated password. */
export function GeneratorPanel({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: GeneratorOptions;
  submitLabel: string;
  onSubmit: (options: GeneratorOptions) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<GeneratorOptions>(initial);
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- only handles Escape; every control inside is natively focusable
    <div
      className="flex flex-col gap-3"
      role="group"
      aria-label={t('generator.title')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <GeneratorPreview options={options} />
      <GeneratorOptionsForm options={options} onChange={setOptions} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button
          tone="primary"
          autoFocus
          onClick={() => {
            onSubmit(options);
          }}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
