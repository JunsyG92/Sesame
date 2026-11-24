import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { lastSegment, normalizeEntryPath } from '../../shared/entryPath';
import type { AppError } from '../../shared/errors';
import type { GeneratorOptions, Settings } from '../../shared/schemas';
import { asPlainSecret, EntryPathSchema, type EntryPath } from '../../shared/types';
import {
  CreateForm,
  EntryDetails,
  EntryEditor,
  GeneratorPanel,
  useCopy,
  useEntry,
  useNameValidation,
} from '../components/entry';
import { EyeIcon, useSecretVisible } from '../components/secrets';
import { Button, Confirm, Highlighted, Toasts } from '../components/ui';
import { errorMessage } from '../i18n';
import { useApi, useEvent } from '../lib/api';
import { useHistory, useListing, useRotation, useToasts } from '../lib/hooks';
import { EntrySearch, type SearchHit } from '../lib/search';

type CreateKind = 'generated' | 'clipboard' | 'manual';
type Item =
  { kind: 'entry'; hit: SearchHit } | { kind: 'create'; create: CreateKind; path: EntryPath };

type View =
  | { name: 'search' }
  | { name: 'detail'; path: EntryPath; edit: boolean }
  | { name: 'create'; initial: string }
  | { name: 'generator'; path: EntryPath };

type Pending =
  | { kind: 'delete'; path: EntryPath }
  | { kind: 'overwrite'; path: EntryPath; retry: () => void }
  | null;

const VIRTUALIZE_ABOVE = 100;
const ROW_HEIGHT = 40;
const HIDE_AFTER_CREATE_MS = 1200;

export const itemId = (index: number): string => `launcher-item-${String(index)}`;

/** The Spotlight-like quick launcher. */
export function Launcher({ settings, mac }: { settings: Settings; mac: boolean }) {
  const api = useApi();
  const { t } = useTranslation();
  const listing = useListing();
  const history = useHistory();
  const rotation = useRotation();
  const expired = useMemo(
    () => new Set(rotation.filter((item) => item.state === 'expired').map((item) => item.path)),
    [rotation],
  );
  const { toasts, push } = useToasts();
  const copy = useCopy(push);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<View>({ name: 'search' });
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [clipboard, setClipboard] = useState<{ length: number; text: string | null }>({
    length: 0,
    text: null,
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const search = useMemo(() => new EntrySearch(listing.entries), [listing.entries]);
  const hits = useMemo(() => search.search(query, history, Date.now()), [search, query, history]);
  const validation = useNameValidation(query);
  const normalized = normalizeEntryPath(query);
  const exact = listing.entries.some((entry) => entry === normalized);

  const creatable = exact ? null : validation.path;
  const items = useMemo<Item[]>(() => {
    const creates: Item[] =
      creatable === null
        ? []
        : (['generated', 'clipboard', 'manual'] as const).map((create) => ({
            kind: 'create',
            create,
            path: creatable,
          }));
    // Strong matches (exact or prefix) stay above the "create" actions so that
    // Enter on a partially typed name copies the existing entry instead of
    // creating a near-duplicate; otherwise the create actions come first.
    const entries = hits.map((hit): Item => ({ kind: 'entry', hit }));
    const strong = entries.filter((item) => item.kind === 'entry' && item.hit.tier <= 1);
    const weak = entries.filter((item) => item.kind === 'entry' && item.hit.tier > 1);
    return [...strong, ...creates, ...weak];
  }, [creatable, hits]);

  const current = items[Math.min(selected, items.length - 1)];
  const currentPath = current?.kind === 'entry' ? current.hit.path : null;

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const resetToSearch = useCallback(() => {
    setView({ name: 'search' });
    setPending(null);
    setClipboard({ length: 0, text: null });
    focusInput();
  }, [focusInput]);

  useEvent(
    'launcher:shown',
    useCallback(() => {
      resetToSearch();
      setSelected(0);
    }, [resetToSearch]),
  );
  useEvent(
    'app:lock',
    useCallback(() => {
      setQuery('');
      resetToSearch();
    }, [resetToSearch]),
  );

  useEffect(() => {
    setSelected(0);
  }, [query]);

  // Peek at the clipboard length (never its content) when the clipboard item is selected.
  const clipboardSelected = current?.kind === 'create' && current.create === 'clipboard';
  useEffect(() => {
    if (!clipboardSelected) return;
    void api.invoke('clipboard:peek', { reveal: false }).then((result) => {
      if (result.ok) setClipboard({ length: result.value.length, text: null });
    });
  }, [api, clipboardSelected]);
  useSecretVisible(clipboard.text !== null);

  const virtual = items.length > VIRTUALIZE_ABOVE;
  // TanStack Virtual returns mutable functions, so React Compiler skips this component.
  // eslint-disable-next-line react-hooks/incompatible-library -- intended, documented above
  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  useEffect(() => {
    if (virtual) virtualizer.scrollToIndex(selected);
    else document.getElementById(itemId(selected))?.scrollIntoView({ block: 'nearest' });
  }, [selected, virtual, virtualizer]);

  const hide = useCallback(() => {
    void api.invoke('app:hideLauncher');
  }, [api]);

  const fail = useCallback(
    (error: AppError, retry?: () => void) => {
      const existing = error.kind === 'entry-exists' ? EntryPathSchema.safeParse(error.path) : null;
      if (existing?.success === true && retry !== undefined) {
        setPending({ kind: 'overwrite', path: existing.data, retry });
      } else if (error.kind !== 'cancelled') push('error', errorMessage(t, error));
    },
    [push, t],
  );

  const created = useCallback(
    (path: EntryPath, copied: boolean) => {
      push('success', t(copied ? 'launcher.createdCopied' : 'launcher.created', { name: path }));
      setQuery(path);
      setView({ name: 'search' });
      if (copied) setTimeout(hide, HIDE_AFTER_CREATE_MS);
    },
    [hide, push, t],
  );

  const createGenerated = useCallback(
    async (path: EntryPath, options: GeneratorOptions, force = false): Promise<void> => {
      setBusy(true);
      const result = await api.invoke('store:generate', {
        path,
        options,
        inPlace: false,
        force,
        copy: true,
      });
      setBusy(false);
      if (result.ok) created(path, true);
      else fail(result.error, () => void createGenerated(path, options, true));
    },
    [api, created, fail],
  );

  const createFromClipboard = useCallback(
    async (path: EntryPath, force = false): Promise<void> => {
      const result = await api.invoke('store:insertFromClipboard', { path, force });
      if (result.ok) created(path, false);
      else fail(result.error, () => void createFromClipboard(path, true));
    },
    [api, created, fail],
  );

  const createManual = useCallback(
    async (path: EntryPath, content: string, force = false): Promise<void> => {
      const result = await api.invoke('store:insert', {
        path,
        content: asPlainSecret(content),
        kind: 'given',
        force,
        copy: true,
      });
      if (result.ok) created(path, true);
      else fail(result.error, () => void createManual(path, content, true));
    },
    [api, created, fail],
  );

  const activate = async (item: Item | undefined, shift: boolean): Promise<void> => {
    if (item === undefined) return;
    if (item.kind === 'entry') {
      const outcome = await copy(item.hit.path, { what: shift ? 'login' : 'password' });
      if (outcome !== null) hide();
      return;
    }
    if (item.create === 'generated') await createGenerated(item.path, settings.generator);
    else if (item.create === 'clipboard') await createFromClipboard(item.path);
    else setView({ name: 'create', initial: item.path });
  };

  const remove = async (path: EntryPath): Promise<void> => {
    setPending(null);
    const result = await api.invoke('store:remove', { path, recursive: false });
    if (result.ok) {
      push('success', t('launcher.deleted', { name: path }));
      resetToSearch();
    } else fail(result.error);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (pending !== null) return;
    const mod = mac ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') {
      event.preventDefault();
      if (view.name !== 'search') resetToSearch();
      else if (query !== '') setQuery('');
      else hide();
      return;
    }
    if (view.name !== 'search') return;
    const handled = (): void => {
      event.preventDefault();
    };
    if (event.key === 'ArrowDown') {
      handled();
      setSelected((index) => Math.min(index + 1, Math.max(0, items.length - 1)));
    } else if (event.key === 'ArrowUp') {
      handled();
      setSelected((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      handled();
      void activate(current, event.shiftKey);
    } else if (
      (event.key === 'Tab' && !event.shiftKey) ||
      (event.key === 'ArrowRight' && isCaretAtEnd())
    ) {
      if (current?.kind === 'entry') {
        handled();
        setView({ name: 'detail', path: current.hit.path, edit: false });
      } else if (current?.kind === 'create' && current.create === 'generated') {
        handled();
        setView({ name: 'generator', path: current.path });
      }
    } else if (mod && key === 'o' && currentPath !== null) {
      handled();
      void copy(currentPath, { what: 'otp' }).then((outcome) => {
        if (outcome !== null) hide();
      });
    } else if (mod && key === 'u' && currentPath !== null) {
      handled();
      void api.invoke('store:openUrl', { path: currentPath }).then((result) => {
        if (result.ok) hide();
        else fail(result.error);
      });
    } else if (mod && key === 'n') {
      handled();
      setView({ name: 'create', initial: normalized });
    } else if (mod && key === 'g') {
      handled();
      if (validation.path !== null) void createGenerated(validation.path, settings.generator);
      else if (validation.error !== null) push('error', validation.error);
    } else if (mod && key === 'e' && currentPath !== null) {
      handled();
      setView({ name: 'detail', path: currentPath, edit: true });
    } else if (mod && event.key === 'Backspace' && currentPath !== null) {
      handled();
      setPending({ kind: 'delete', path: currentPath });
    }
  };

  const isCaretAtEnd = (): boolean => {
    const input = inputRef.current;
    return input === null || input.selectionStart === input.value.length;
  };

  const revealClipboard = async (): Promise<void> => {
    if (clipboard.text !== null) {
      setClipboard({ length: clipboard.length, text: null });
      return;
    }
    const result = await api.invoke('clipboard:peek', { reveal: true });
    if (result.ok) setClipboard(result.value);
  };

  const label = (item: Item): string => {
    if (item.kind === 'entry') return item.hit.path;
    const key = {
      generated: 'launcher.createGenerated',
      clipboard: 'launcher.createClipboard',
      manual: 'launcher.createManual',
    }[item.create];
    return t(key, { name: item.path });
  };

  const renderItem = (item: Item, index: number) => {
    const active = index === selected;
    return (
      <div
        key={item.kind === 'entry' ? item.hit.path : `create-${item.create}`}
        id={itemId(index)}
        role="option"
        aria-selected={active}
        tabIndex={-1}
        className={`flex h-10 cursor-default items-center justify-between gap-2 rounded-md px-3 text-sm ${
          active
            ? 'bg-amber-100 text-zinc-900 dark:bg-amber-900/40 dark:text-zinc-50'
            : 'text-zinc-700 dark:text-zinc-300'
        }`}
        onMouseMove={() => {
          if (!active) setSelected(index);
        }}
        onClick={() => void activate(item, false)}
        onKeyDown={() => undefined}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="w-4 text-center text-zinc-400">
            {item.kind === 'entry'
              ? '🔑'
              : item.create === 'generated'
                ? '⚄'
                : item.create === 'clipboard'
                  ? '📋'
                  : '✎'}
          </span>
          <span className="truncate">
            {item.kind === 'entry' ? (
              <>
                <span className="text-zinc-400 dark:text-zinc-500">
                  <Highlighted
                    text={item.hit.path.slice(
                      0,
                      item.hit.path.length - lastSegment(item.hit.path).length,
                    )}
                    ranges={item.hit.ranges}
                  />
                </span>
                <Highlighted
                  text={lastSegment(item.hit.path)}
                  ranges={item.hit.ranges.map(([start, end]) => {
                    const offset = item.hit.path.length - lastSegment(item.hit.path).length;
                    return [start - offset, end - offset] as const;
                  })}
                />
              </>
            ) : (
              label(item)
            )}
          </span>
        </span>
        {item.kind === 'entry' && expired.has(item.hit.path) ? (
          <span className="shrink-0 rounded bg-red-100 px-1.5 text-xs text-red-800 dark:bg-red-900/50 dark:text-red-100">
            ⚠ {t('rotation.expiredMark')}
          </span>
        ) : null}
        {item.kind === 'create' && item.create === 'clipboard' && active ? (
          <span className="flex items-center gap-1 text-xs text-zinc-500">
            {clipboard.length === 0 ? (
              t('launcher.clipboardEmpty')
            ) : clipboard.text !== null ? (
              <code className="max-w-48 truncate font-mono">{clipboard.text}</code>
            ) : (
              t('launcher.clipboardPreview', { length: clipboard.length })
            )}
            {clipboard.length > 0 ? (
              <button
                type="button"
                className="rounded p-1 hover:bg-amber-200 dark:hover:bg-amber-800"
                aria-label={clipboard.text === null ? t('launcher.reveal') : t('launcher.conceal')}
                aria-pressed={clipboard.text !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  void revealClipboard();
                }}
              >
                <EyeIcon open={clipboard.text === null} />
              </button>
            ) : null}
          </span>
        ) : null}
        {item.kind === 'create' && item.create === 'generated' && active ? (
          <button
            type="button"
            className="rounded px-1 text-xs text-zinc-500 hover:bg-amber-200 dark:hover:bg-amber-800"
            onClick={(event) => {
              event.stopPropagation();
              setView({ name: 'generator', path: item.path });
            }}
          >
            {t('launcher.adjust')} →
          </button>
        ) : null}
      </div>
    );
  };

  const modKey = mac ? '⌘' : 'Ctrl+';

  return (
    // The container only relays keyboard shortcuts typed in the search field.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="flex h-screen flex-col overflow-hidden rounded-xl border border-zinc-300 bg-white/95 shadow-2xl backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95"
      onKeyDown={onKeyDown}
    >
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-700">
        <span aria-hidden="true" className="text-lg text-amber-600">
          ⌕
        </span>
        <input
          ref={inputRef}
          autoFocus
          role="combobox"
          aria-label={t('launcher.label')}
          aria-expanded={view.name === 'search'}
          aria-controls="launcher-results"
          aria-activedescendant={
            view.name === 'search' && current !== undefined ? itemId(selected) : undefined
          }
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          className="h-14 flex-1 bg-transparent text-lg text-zinc-900 placeholder:text-zinc-400 focus:outline-none dark:text-zinc-100"
          placeholder={t('launcher.placeholder')}
          value={view.name === 'search' ? query : view.name === 'create' ? view.initial : view.path}
          readOnly={view.name !== 'search'}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        {busy ? <span className="text-xs text-zinc-500">{t('common.loading')}</span> : null}
      </div>

      {expired.size > 0 && view.name === 'search' ? (
        <div
          role="status"
          className="flex items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-4 py-1.5 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100"
        >
          <span>⚠ {t('rotation.banner', { count: expired.size })}</span>
          <button
            type="button"
            className="rounded px-2 py-0.5 font-medium hover:bg-red-100 dark:hover:bg-red-900"
            onClick={() => void api.invoke('app:openManager', { tab: 'rotation' })}
          >
            {t('rotation.bannerAction')} →
          </button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-2" ref={listRef}>
        {view.name === 'search' ? (
          <div id="launcher-results" role="listbox" aria-label={t('launcher.results')}>
            {items.length === 0 ? (
              <p className="p-3 text-sm text-zinc-500">
                {listing.entries.length === 0
                  ? t('launcher.empty')
                  : (validation.error ?? t('launcher.noMatch'))}
              </p>
            ) : virtual ? (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((row) => {
                  const item = items[row.index];
                  return item === undefined ? null : (
                    <div
                      key={row.key}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        transform: `translateY(${String(row.start)}px)`,
                      }}
                    >
                      {renderItem(item, row.index)}
                    </div>
                  );
                })}
              </div>
            ) : (
              items.map(renderItem)
            )}
            {validation.error !== null && items.length > 0 ? (
              <p className="px-3 py-2 text-xs text-red-600">{validation.error}</p>
            ) : null}
          </div>
        ) : view.name === 'detail' ? (
          <LauncherDetail
            path={view.path}
            edit={view.edit}
            generator={settings.generator}
            notify={push}
            onEdit={(edit) => {
              setView({ name: 'detail', path: view.path, edit });
            }}
            onDelete={() => {
              setPending({ kind: 'delete', path: view.path });
            }}
          />
        ) : view.name === 'create' ? (
          <div className="p-2">
            <CreateForm
              initialName={view.initial}
              generator={settings.generator}
              onCancel={resetToSearch}
              onSubmit={(path, content) => void createManual(path, content)}
            />
          </div>
        ) : (
          <div className="p-2">
            <GeneratorPanel
              initial={settings.generator}
              submitLabel={t('generator.saveAndCopy')}
              onCancel={resetToSearch}
              onSubmit={(options) => void createGenerated(view.path, options)}
            />
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-zinc-200 px-3 py-1.5 text-[11px] text-zinc-500 dark:border-zinc-700">
        <span className="truncate">{t('launcher.hints', { mod: modKey })}</span>
        <button
          type="button"
          className="shrink-0 hover:text-amber-600"
          onClick={() => void api.invoke('app:openManager')}
        >
          {t('launcher.openManager')}
        </button>
      </div>

      {pending === null ? null : (
        <Confirm
          message={
            pending.kind === 'delete'
              ? t('launcher.deleteConfirm', { name: pending.path })
              : t('launcher.overwriteConfirm', { name: pending.path })
          }
          confirmLabel={pending.kind === 'delete' ? t('common.delete') : t('common.confirm')}
          cancelLabel={t('common.cancel')}
          danger
          onCancel={() => {
            setPending(null);
            focusInput();
          }}
          onConfirm={() => {
            if (pending.kind === 'delete') void remove(pending.path);
            else {
              setPending(null);
              pending.retry();
            }
          }}
        />
      )}
      <Toasts toasts={toasts} />
    </div>
  );
}

function LauncherDetail({
  path,
  edit,
  generator,
  notify,
  onEdit,
  onDelete,
}: {
  path: EntryPath;
  edit: boolean;
  generator: GeneratorOptions;
  notify: (tone: 'info' | 'success' | 'error', text: string) => void;
  onEdit: (edit: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const { entry, error, loading } = useEntry(path, version);
  if (loading) return <p className="p-3 text-sm text-zinc-500">{t('entry.decrypting')}</p>;
  if (error !== null) return <p className="p-3 text-sm text-red-600">{errorMessage(t, error)}</p>;
  if (entry === null) return null;
  if (edit) {
    return (
      <div className="p-2">
        <EntryEditor
          entry={entry}
          generator={generator}
          notify={notify}
          onDone={(saved) => {
            if (saved) setVersion((value) => value + 1);
            onEdit(false);
          }}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 p-2">
      <EntryDetails
        entry={entry}
        notify={notify}
        compact
        onChanged={() => {
          setVersion((value) => value + 1);
        }}
      />
      <div className="flex gap-2">
        <Button
          autoFocus
          onClick={() => {
            onEdit(true);
          }}
        >
          ✎ {t('common.edit')}
        </Button>
        <Button tone="ghost" onClick={onDelete}>
          🗑 {t('common.delete')}
        </Button>
      </div>
    </div>
  );
}
