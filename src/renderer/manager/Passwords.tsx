import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { lastSegment, parentFolder } from '../../shared/entryPath';
import type { Settings, StoreListing } from '../../shared/schemas';
import { asPlainSecret, EntryPathSchema, type EntryPath } from '../../shared/types';
import {
  CreateForm,
  EntryDetails,
  EntryEditor,
  useEntry,
  useNameValidation,
  type Notify,
} from '../components/entry';
import { Button, Confirm, Field, Highlighted, inputClass, Modal } from '../components/ui';
import { errorMessage } from '../i18n';
import { useApi } from '../lib/api';
import { useHistory } from '../lib/hooks';
import { EntrySearch } from '../lib/search';

const ROW = 34;
const DRAG_TYPE = 'application/x-sesame-entry';

function FolderTree({
  folders,
  selected,
  onSelect,
  onDrop,
}: {
  folders: readonly string[];
  selected: string;
  onSelect: (folder: string) => void;
  onDrop: (entry: EntryPath, folder: string) => void;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState<string | null>(null);
  const dropProps = (folder: string) => ({
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes(DRAG_TYPE)) {
        event.preventDefault();
        setOver(folder);
      }
    },
    onDragLeave: () => {
      setOver(null);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setOver(null);
      const parsed = EntryPathSchema.safeParse(event.dataTransfer.getData(DRAG_TYPE));
      if (parsed.success) onDrop(parsed.data, folder);
    },
  });
  const row = (folder: string, label: string, depth: number) => (
    <li key={folder || '/'}>
      <button
        type="button"
        {...dropProps(folder)}
        aria-current={selected === folder ? 'true' : undefined}
        title={over === folder ? t('manager.dropHere') : folder || t('manager.allPasswords')}
        className={`w-full truncate rounded px-2 py-1 text-left text-sm ${
          over === folder
            ? 'bg-amber-200 dark:bg-amber-800'
            : selected === folder
              ? 'bg-zinc-200 font-medium dark:bg-zinc-700'
              : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
        }`}
        style={{ paddingLeft: `${String(8 + depth * 14)}px` }}
        onClick={() => {
          onSelect(folder);
        }}
      >
        {depth === 0 && folder === '' ? '🗄 ' : '📁 '}
        {label}
      </button>
    </li>
  );
  return (
    <nav aria-label={t('manager.folders')} className="overflow-auto p-2">
      <ul>
        {row('', t('manager.allPasswords'), 0)}
        {folders.map((folder) => row(folder, lastSegment(folder), folder.split('/').length))}
      </ul>
    </nav>
  );
}

function EntryList({
  listing,
  folder,
  filter,
  selected,
  onSelect,
}: {
  listing: StoreListing;
  folder: string;
  filter: string;
  selected: EntryPath | null;
  onSelect: (path: EntryPath) => void;
}) {
  const { t } = useTranslation();
  const history = useHistory();
  const scrollRef = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => {
    const scoped =
      folder === ''
        ? listing.entries
        : listing.entries.filter((entry) => entry.startsWith(`${folder}/`));
    return filter.trim() === ''
      ? scoped.map((path) => ({ path, ranges: [], tier: 3 as const }))
      : new EntrySearch(scoped).search(filter, history, Date.now());
  }, [listing.entries, folder, filter, history]);
  // TanStack Virtual returns mutable functions, so React Compiler skips this component.
  // eslint-disable-next-line react-hooks/incompatible-library -- intended, documented above
  const virtualizer = useVirtualizer({
    count: hits.length > 100 ? hits.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 10,
  });
  const row = (index: number) => {
    const hit = hits[index];
    if (hit === undefined) return null;
    return (
      <button
        type="button"
        role="option"
        aria-selected={selected === hit.path}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, hit.path);
          event.dataTransfer.effectAllowed = 'move';
        }}
        className={`flex h-[34px] w-full items-center truncate rounded px-2 text-left text-sm ${
          selected === hit.path
            ? 'bg-amber-100 dark:bg-amber-900/40'
            : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
        }`}
        onClick={() => {
          onSelect(hit.path);
        }}
      >
        <Highlighted text={hit.path} ranges={hit.ranges} />
      </button>
    );
  };
  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-2">
      <div role="listbox" aria-label={t('manager.entries', { count: hits.length })}>
        {hits.length > 100 ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={item.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${String(item.start)}px)`,
                }}
              >
                {row(item.index)}
              </div>
            ))}
          </div>
        ) : (
          hits.map((_hit, index) => <div key={hits[index]?.path}>{row(index)}</div>)
        )}
      </div>
    </div>
  );
}

function RenameDialog({
  path,
  mode,
  onClose,
  notify,
}: {
  path: EntryPath;
  mode: 'move' | 'duplicate';
  onClose: (target: EntryPath | null) => void;
  notify: Notify;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const [name, setName] = useState(mode === 'move' ? path : `${path}-copy`);
  const [overwrite, setOverwrite] = useState(false);
  const validation = useNameValidation(name);
  const run = async (force: boolean): Promise<void> => {
    if (validation.path === null) return;
    const channel = mode === 'move' ? 'store:move' : 'store:duplicate';
    const result = await api.invoke(channel, { from: path, to: validation.path, force });
    if (result.ok) onClose(validation.path);
    else if (result.error.kind === 'entry-exists') setOverwrite(true);
    else notify('error', errorMessage(t, result.error));
  };
  return (
    <Modal
      title={mode === 'move' ? t('entry.rename') : t('entry.duplicate')}
      onClose={() => {
        onClose(null);
      }}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(false);
        }}
      >
        <Field label={t('entry.newName')} help={validation.error ?? t('create.nameHelp')}>
          <input
            autoFocus
            className={inputClass}
            value={name}
            aria-invalid={validation.error !== null}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              onClose(null);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button tone="primary" type="submit" disabled={validation.path === null}>
            {t('common.save')}
          </Button>
        </div>
      </form>
      {overwrite ? (
        <Confirm
          message={t('launcher.overwriteConfirm', { name })}
          confirmLabel={t('common.confirm')}
          cancelLabel={t('common.cancel')}
          danger
          onCancel={() => {
            setOverwrite(false);
          }}
          onConfirm={() => {
            setOverwrite(false);
            void run(true);
          }}
        />
      ) : null}
    </Modal>
  );
}

function EntryPanel({
  path,
  settings,
  notify,
  onSelect,
}: {
  path: EntryPath;
  settings: Settings;
  notify: Notify;
  onSelect: (path: EntryPath | null) => void;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const [version, setVersion] = useState(0);
  const [mode, setMode] = useState<'view' | 'edit' | 'move' | 'duplicate' | 'delete'>('view');
  const { entry, error, loading } = useEntry(path, version);
  if (loading) return <p className="p-4 text-sm text-zinc-500">{t('entry.decrypting')}</p>;
  if (error !== null) return <p className="p-4 text-sm text-red-600">{errorMessage(t, error)}</p>;
  if (entry === null) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <h2 className="mb-3 truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100">
        {path}
      </h2>
      {mode === 'edit' ? (
        <EntryEditor
          entry={entry}
          generator={settings.generator}
          notify={notify}
          onDone={(saved) => {
            setMode('view');
            if (saved) setVersion((value) => value + 1);
          }}
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            <Button
              tone="primary"
              onClick={() => {
                setMode('edit');
              }}
            >
              ✎ {t('common.edit')}
            </Button>
            <Button
              onClick={() => {
                setMode('move');
              }}
            >
              {t('entry.rename')}
            </Button>
            <Button
              onClick={() => {
                setMode('duplicate');
              }}
            >
              {t('entry.duplicate')}
            </Button>
            <Button
              tone="ghost"
              onClick={() => {
                setMode('delete');
              }}
            >
              🗑 {t('common.delete')}
            </Button>
          </div>
          <EntryDetails
            entry={entry}
            notify={notify}
            onChanged={() => {
              setVersion((value) => value + 1);
            }}
          />
        </>
      )}
      {mode === 'move' || mode === 'duplicate' ? (
        <RenameDialog
          path={path}
          mode={mode}
          notify={notify}
          onClose={(target) => {
            setMode('view');
            if (target !== null) onSelect(target);
          }}
        />
      ) : null}
      {mode === 'delete' ? (
        <Confirm
          message={t('launcher.deleteConfirm', { name: path })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          onCancel={() => {
            setMode('view');
          }}
          onConfirm={() => {
            void api.invoke('store:remove', { path, recursive: false }).then((result) => {
              setMode('view');
              if (result.ok) {
                notify('success', t('launcher.deleted', { name: path }));
                onSelect(null);
              } else notify('error', errorMessage(t, result.error));
            });
          }}
        />
      ) : null}
    </div>
  );
}

/** Folder tree + list + entry detail, with drag-and-drop moves. */
export function Passwords({
  listing,
  settings,
  notify,
}: {
  listing: StoreListing;
  settings: Settings;
  notify: Notify;
}) {
  const api = useApi();
  const { t } = useTranslation();
  const [folder, setFolder] = useState('');
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<EntryPath | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingFolder, setDeletingFolder] = useState(false);

  const moveTo = async (entry: EntryPath, target: string): Promise<void> => {
    if (parentFolder(entry) === target) return;
    const to = EntryPathSchema.safeParse(
      target === '' ? lastSegment(entry) : `${target}/${lastSegment(entry)}`,
    );
    if (!to.success) return;
    const result = await api.invoke('store:move', { from: entry, to: to.data, force: false });
    if (result.ok) {
      notify('success', t('manager.moved', { name: to.data }));
      if (selected === entry) setSelected(to.data);
    } else notify('error', errorMessage(t, result.error));
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[220px_300px_1fr]">
      <aside className="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-700">
        <FolderTree
          folders={listing.folders}
          selected={folder}
          onSelect={setFolder}
          onDrop={(entry, target) => void moveTo(entry, target)}
        />
        {folder === '' ? null : (
          <div className="mt-auto border-t border-zinc-200 p-2 dark:border-zinc-700">
            <Button
              tone="ghost"
              onClick={() => {
                setDeletingFolder(true);
              }}
            >
              🗑 {lastSegment(folder)}
            </Button>
          </div>
        )}
      </aside>
      <section className="flex min-h-0 flex-col border-r border-zinc-200 dark:border-zinc-700">
        <div className="flex gap-2 border-b border-zinc-200 p-2 dark:border-zinc-700">
          <input
            className={inputClass}
            placeholder={t('manager.search')}
            aria-label={t('manager.search')}
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
          <Button
            tone="primary"
            aria-label={t('manager.newEntry')}
            title={t('manager.newEntry')}
            onClick={() => {
              setCreating(true);
            }}
          >
            +
          </Button>
        </div>
        <EntryList
          listing={listing}
          folder={folder}
          filter={filter}
          selected={selected}
          onSelect={setSelected}
        />
      </section>
      <section className="flex min-h-0 flex-col">
        {selected === null || !listing.entries.includes(selected) ? (
          <p className="p-4 text-sm text-zinc-500">{t('entry.none')}</p>
        ) : (
          <EntryPanel
            key={selected}
            path={selected}
            settings={settings}
            notify={notify}
            onSelect={setSelected}
          />
        )}
      </section>
      {creating ? (
        <Modal
          title={t('create.title')}
          onClose={() => {
            setCreating(false);
          }}
        >
          <CreateForm
            initialName={folder === '' ? '' : `${folder}/`}
            generator={settings.generator}
            onCancel={() => {
              setCreating(false);
            }}
            onSubmit={(path, content) => {
              void api
                .invoke('store:insert', {
                  path,
                  content: asPlainSecret(content),
                  kind: 'given',
                  force: false,
                  copy: false,
                })
                .then((result) => {
                  if (result.ok) {
                    setCreating(false);
                    setSelected(path);
                    notify('success', t('launcher.created', { name: path }));
                  } else notify('error', errorMessage(t, result.error));
                });
            }}
          />
        </Modal>
      ) : null}
      {deletingFolder ? (
        <Confirm
          message={t('manager.deleteFolder', { name: folder })}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          onCancel={() => {
            setDeletingFolder(false);
          }}
          onConfirm={() => {
            const target = EntryPathSchema.safeParse(folder);
            setDeletingFolder(false);
            if (!target.success) return;
            void api
              .invoke('store:remove', { path: target.data, recursive: true })
              .then((result) => {
                if (result.ok) setFolder(parentFolder(folder));
                else notify('error', errorMessage(t, result.error));
              });
          }}
        />
      ) : null}
    </div>
  );
}
