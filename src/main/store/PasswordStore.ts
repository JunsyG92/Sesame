import { randomBytes } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { AppError } from '../../shared/errors';
import { err, ok, type Result } from '../../shared/result';
import type { GrepMatch, RecipientsInfo, StoreListing } from '../../shared/schemas';
import {
  asPlainSecret,
  GpgKeyIdSchema,
  ROOT_FOLDER,
  type EntryPath,
  type FolderPath,
  type GpgKeyId,
  type PlainSecret,
} from '../../shared/types';
import { replaceFirstLine, splitLines } from './entry';
import type { Git } from './git';
import type { Gpg } from './gpg';
import {
  checkCreatable,
  entryNameFromRelative,
  GPG_EXTENSION,
  GPG_ID_FILE,
  resolveInStore,
} from './paths';

export type ProgressListener = (done: number, total: number) => void;

export interface JobOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressListener;
}

export interface InsertOptions {
  readonly force: boolean;
  /** Selects the commit message: `pass insert` vs `pass generate`. */
  readonly kind: 'given' | 'generated';
}

interface Recipients {
  readonly ids: readonly GpgKeyId[];
  /** Absolute directory of the `.gpg-id` in effect, null with `PASSWORD_STORE_KEY`. */
  readonly definedIn: string | null;
}

type Async<T> = Promise<Result<T, AppError>>;

const CANCELLED: AppError = { kind: 'cancelled' };

async function pathKind(target: string): Promise<'file' | 'dir' | null> {
  try {
    const info = await stat(target);
    return info.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

function ioError(error: unknown): AppError {
  /* v8 ignore next -- Node.js filesystem errors always carry a code */
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
  return { kind: 'io', message: code };
}

/** Wraps filesystem calls so that I/O failures become typed errors. */
async function io<T>(operation: () => Promise<T>): Async<T> {
  try {
    return ok(await operation());
  } catch (error) {
    return err(ioError(error));
  }
}

const withNewline = (content: string): PlainSecret =>
  asPlainSecret(content.endsWith('\n') ? content : `${content}\n`);

const sameRecipients = (a: Recipients, b: Recipients): boolean =>
  a.ids.length === b.ids.length && [...a.ids].sort().join('\n') === [...b.ids].sort().join('\n');

/**
 * TypeScript implementation of the `pass` storage protocol. The on-disk layout
 * (one `name.gpg` per entry, `.gpg-id` files, git commit messages) is exactly
 * the one produced by `pass`, so both tools can share a store.
 */
export class PasswordStore {
  public readonly dir: string;

  public constructor(
    storeDir: string,
    private readonly gpg: Gpg,
    private readonly git: Git,
    private readonly env: NodeJS.ProcessEnv,
    /** Injectable for tests; always `resolveInStore` in the application. */
    private readonly resolve: typeof resolveInStore = resolveInStore,
  ) {
    this.dir = path.resolve(storeDir);
  }

  private entryFile(entry: EntryPath): Result<string, AppError> {
    return this.resolve(this.dir, entry, GPG_EXTENSION);
  }

  /* ------------------------------------------------------------ listing */

  public async exists(): Promise<boolean> {
    return (await pathKind(this.dir)) === 'dir';
  }

  public async isInitialized(): Promise<boolean> {
    return (await pathKind(path.join(this.dir, GPG_ID_FILE))) === 'file';
  }

  public isGitRepo(): Promise<boolean> {
    return this.git.isRepo(this.dir);
  }

  private async walk(dir: string, entries: EntryPath[], folders: string[]): Promise<void> {
    let children;
    try {
      children = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      const absolute = path.join(dir, child.name);
      const relative = path.relative(this.dir, absolute);
      // Follow symlinks like `pass` does (`tree -l`).
      const kind = child.isSymbolicLink()
        ? await pathKind(absolute)
        : child.isDirectory()
          ? 'dir'
          : 'file';
      if (kind === 'dir') {
        folders.push(relative.split(path.sep).join('/'));
        await this.walk(absolute, entries, folders);
      } else if (kind === 'file') {
        const name = entryNameFromRelative(relative);
        if (name !== null) entries.push(name);
      }
    }
  }

  /** `pass ls`: every entry name and folder, without decrypting anything. */
  public async list(folder: FolderPath = ROOT_FOLDER): Async<StoreListing> {
    const start = this.resolve(this.dir, folder);
    if (!start.ok) return start;
    const entries: EntryPath[] = [];
    const folders: string[] = [];
    await this.walk(start.value, entries, folders);
    entries.sort();
    folders.sort();
    return ok({ entries, folders });
  }

  public async has(entry: EntryPath): Promise<boolean> {
    const file = this.entryFile(entry);
    return file.ok && (await pathKind(file.value)) === 'file';
  }

  /* --------------------------------------------------------- recipients */

  private parseGpgIds(content: string): Result<GpgKeyId[], AppError> {
    const ids: GpgKeyId[] = [];
    for (const line of content.split(/\r?\n/)) {
      const value = line.replace(/#.*$/, '').trim();
      if (value === '') continue;
      const parsed = GpgKeyIdSchema.safeParse(value);
      if (!parsed.success) {
        return err({ kind: 'invalid-argument', message: 'invalid recipient in .gpg-id' });
      }
      ids.push(parsed.data);
    }
    return ok(ids);
  }

  /** Finds the closest `.gpg-id` walking up from `directory` to the store root. */
  private async recipientsForDir(directory: string): Async<Recipients> {
    const override = this.env.PASSWORD_STORE_KEY;
    if (override !== undefined && override.trim() !== '') {
      const ids = this.parseGpgIds(override.split(/\s+/).join('\n'));
      return ids.ok ? ok({ ids: ids.value, definedIn: null }) : ids;
    }
    let current = directory;
    for (;;) {
      let content: string | null = null;
      try {
        content = await readFile(path.join(current, GPG_ID_FILE), 'utf8');
      } catch {
        content = null;
      }
      if (content !== null) {
        const ids = this.parseGpgIds(content);
        if (!ids.ok) return ids;
        if (ids.value.length === 0) return err({ kind: 'store-not-initialized' });
        return ok({ ids: ids.value, definedIn: current });
      }
      const parent = path.dirname(current);
      if (current === this.dir || parent === current || !current.startsWith(this.dir)) break;
      current = parent;
    }
    return err({ kind: 'store-not-initialized' });
  }

  /** Recipients in effect for a folder (the UI of `pass init --path`). */
  public async recipients(folder: FolderPath): Async<RecipientsInfo> {
    const dir = this.resolve(this.dir, folder);
    if (!dir.ok) return dir;
    const found = await this.recipientsForDir(dir.value);
    if (!found.ok) {
      if (found.error.kind === 'store-not-initialized') {
        return ok({ ids: [], definedIn: null, own: false });
      }
      return found;
    }
    const definedIn =
      found.value.definedIn === null
        ? null
        : path.relative(this.dir, found.value.definedIn).split(path.sep).join('/');
    return ok({ ids: [...found.value.ids], definedIn, own: found.value.definedIn === dir.value });
  }

  /* ------------------------------------------------------------ helpers */

  private async writeEncrypted(file: string, to: Recipients, content: PlainSecret): Async<null> {
    const made = await io(() => mkdir(path.dirname(file), { recursive: true }));
    if (!made.ok) return made;
    // Encrypt next to the target, then rename: readers never see a partial file.
    const temporary = `${file}.tmp-${randomBytes(6).toString('hex')}`;
    const encrypted = await this.gpg.encrypt(to.ids, content, temporary);
    if (!encrypted.ok) {
      await rm(temporary, { force: true });
      return encrypted;
    }
    const moved = await io(() => rename(temporary, file));
    if (!moved.ok) await rm(temporary, { force: true });
    return moved.ok ? ok(null) : moved;
  }

  private async pruneEmptyParents(start: string): Promise<void> {
    let current = start;
    while (current !== this.dir && current.startsWith(this.dir + path.sep)) {
      try {
        await rmdir(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  private commit(files: readonly string[], message: string): Async<null> {
    return this.git.commit(this.dir, files, message);
  }

  /* -------------------------------------------------------- show/insert */

  /** `pass show`: decrypts one entry. */
  public async show(entry: EntryPath, signal?: AbortSignal): Async<PlainSecret> {
    const file = this.entryFile(entry);
    if (!file.ok) return file;
    if ((await pathKind(file.value)) !== 'file') {
      return err({ kind: 'entry-not-found', path: entry });
    }
    return this.gpg.decrypt(file.value, signal);
  }

  /** `pass insert` / first half of `pass generate`. */
  public async insert(entry: EntryPath, content: PlainSecret, options: InsertOptions): Async<null> {
    const creatable = checkCreatable(entry);
    if (!creatable.ok) return creatable;
    const file = this.entryFile(entry);
    if (!file.ok) return file;
    if (!options.force && (await pathKind(file.value)) !== null) {
      return err({ kind: 'entry-exists', path: entry });
    }
    const to = await this.recipientsForDir(path.dirname(file.value));
    if (!to.ok) return to;
    const written = await this.writeEncrypted(file.value, to.value, withNewline(content));
    if (!written.ok) return written;
    const message =
      options.kind === 'generated'
        ? `Add generated password for ${entry}.`
        : `Add given password for ${entry} to store.`;
    return this.commit([file.value], message);
  }

  /** `pass generate --in-place`: replaces the first line, keeps the rest. */
  public async replacePassword(
    entry: EntryPath,
    password: PlainSecret,
    /** Extra change applied to the new content (e.g. recording the change date). */
    transform: (content: string) => string = (content) => content,
  ): Async<PlainSecret> {
    const current = await this.show(entry);
    if (!current.ok) return current;
    const content = asPlainSecret(transform(replaceFirstLine(current.value, password)));
    const written = await this.write(entry, content, `Replace generated password for ${entry}.`);
    return written.ok ? ok(content) : written;
  }

  /** `pass edit` with the built-in editor. */
  public edit(entry: EntryPath, content: PlainSecret): Async<null> {
    return this.write(entry, content, `Edit password for ${entry} using Sesame.`);
  }

  private async write(entry: EntryPath, content: PlainSecret, message: string): Async<null> {
    const file = this.entryFile(entry);
    if (!file.ok) return file;
    if ((await pathKind(file.value)) !== 'file') {
      return err({ kind: 'entry-not-found', path: entry });
    }
    const to = await this.recipientsForDir(path.dirname(file.value));
    if (!to.ok) return to;
    const written = await this.writeEncrypted(file.value, to.value, withNewline(content));
    if (!written.ok) return written;
    return this.commit([file.value], message);
  }

  /* ----------------------------------------------------------------- rm */

  /** `pass rm [-r]`: removes an entry, or a whole folder when `recursive`. */
  public async remove(target: EntryPath, recursive: boolean): Async<null> {
    const resolved = recursive ? this.resolve(this.dir, target) : this.entryFile(target);
    if (!resolved.ok) return resolved;
    if ((await pathKind(resolved.value)) !== (recursive ? 'dir' : 'file')) {
      return err({ kind: 'entry-not-found', path: target });
    }
    const removed = await io(() => rm(resolved.value, { recursive, force: true }));
    if (!removed.ok) return removed;
    await this.pruneEmptyParents(path.dirname(resolved.value));
    return this.commit([resolved.value], `Remove ${target} from store.`);
  }

  /* -------------------------------------------------------------- mv/cp */

  /** `pass mv`: renames an entry or a folder, re-encrypting when recipients differ. */
  public move(from: EntryPath, to: EntryPath, force: boolean): Async<null> {
    return this.transfer(from, to, force, 'move');
  }

  /** `pass cp`: duplicates an entry or a folder, re-encrypting when recipients differ. */
  public copy(from: EntryPath, to: EntryPath, force: boolean): Async<null> {
    return this.transfer(from, to, force, 'copy');
  }

  private async transferFile(source: string, target: string, mode: 'move' | 'copy'): Async<null> {
    const before = await this.recipientsForDir(path.dirname(source));
    if (!before.ok) return before;
    const after = await this.recipientsForDir(path.dirname(target));
    if (!after.ok) return after;
    if (sameRecipients(before.value, after.value)) {
      return io(async () => {
        await mkdir(path.dirname(target), { recursive: true });
        await (mode === 'move' ? rename(source, target) : copyFile(source, target));
        return null;
      });
    }
    const plaintext = await this.gpg.decrypt(source);
    if (!plaintext.ok) return plaintext;
    const written = await this.writeEncrypted(target, after.value, plaintext.value);
    if (!written.ok) return written;
    return mode === 'move' ? io(() => rm(source).then(() => null)) : ok(null);
  }

  private async transferFolder(source: string, target: string, mode: 'move' | 'copy'): Async<null> {
    const files: string[] = [];
    const collect = async (dir: string): Promise<void> => {
      for (const child of await readdir(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, child.name);
        if (child.isDirectory()) await collect(absolute);
        else if (child.name === GPG_ID_FILE || child.name.endsWith(GPG_EXTENSION)) {
          files.push(path.relative(source, absolute));
        }
      }
    };
    const collected = await io(() => collect(source));
    if (!collected.ok) return collected;
    // `.gpg-id` files go first so that recipients are resolved correctly at the target.
    const isGpgId = (file: string): boolean => path.basename(file) === GPG_ID_FILE;
    const ordered = [...files.filter(isGpgId), ...files.filter((file) => !isGpgId(file))];
    // A folder is always copied first and the source removed only once every
    // entry made it: a failure half-way never leaves a partially moved folder.
    const targetExisted = (await pathKind(target)) !== null;
    for (const relative of ordered) {
      const destination = path.join(target, relative);
      const result = isGpgId(relative)
        ? await io(async () => {
            await mkdir(path.dirname(destination), { recursive: true });
            await copyFile(path.join(source, relative), destination);
            return null;
          })
        : await this.transferFile(path.join(source, relative), destination, 'copy');
      if (!result.ok) {
        if (!targetExisted) await rm(target, { recursive: true, force: true });
        return result;
      }
    }
    if (mode === 'copy') return ok(null);
    return io(() => rm(source, { recursive: true, force: true }).then(() => null));
  }

  private async transfer(
    from: EntryPath,
    to: EntryPath,
    force: boolean,
    mode: 'move' | 'copy',
  ): Async<null> {
    const creatable = checkCreatable(to);
    if (!creatable.ok) return creatable;
    if (to === from || to.startsWith(`${from}/`)) {
      return err({ kind: 'invalid-argument', message: 'source and destination overlap' });
    }
    const sourceFile = this.entryFile(from);
    const targetFile = this.entryFile(to);
    const sourceDir = this.resolve(this.dir, from);
    const targetDir = this.resolve(this.dir, to);
    if (!sourceFile.ok) return sourceFile;
    if (!targetFile.ok) return targetFile;
    if (!sourceDir.ok) return sourceDir;
    if (!targetDir.ok) return targetDir;

    const isEntry = (await pathKind(sourceFile.value)) === 'file';
    if (!isEntry && (await pathKind(sourceDir.value)) !== 'dir') {
      return err({ kind: 'entry-not-found', path: from });
    }
    const source = isEntry ? sourceFile.value : sourceDir.value;
    const target = isEntry ? targetFile.value : targetDir.value;
    if (!force && (await pathKind(target)) !== null) return err({ kind: 'entry-exists', path: to });

    const moved = isEntry
      ? await this.transferFile(source, target, mode)
      : await this.transferFolder(source, target, mode);
    if (!moved.ok) return moved;
    if (mode === 'move') await this.pruneEmptyParents(path.dirname(source));
    return mode === 'move'
      ? this.commit([source, target], `Rename ${from} to ${to}.`)
      : this.commit([target], `Copy ${from} to ${to}.`);
  }

  /* --------------------------------------------------------------- grep */

  /** `pass grep`: decrypts every entry on demand and reports matching lines. */
  public async grep(pattern: string, regex: boolean, job: JobOptions = {}): Async<GrepMatch[]> {
    let matcher: (line: string) => boolean;
    if (regex) {
      let expression: RegExp;
      try {
        // The pattern is typed by the user to search their own data (same as `pass grep`).
        // eslint-disable-next-line security/detect-non-literal-regexp
        expression = new RegExp(pattern, 'i');
      } catch {
        return err({ kind: 'invalid-argument', message: 'invalid regular expression' });
      }
      matcher = (line) => expression.test(line);
    } else {
      const needle = pattern.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(needle);
    }
    const listing = await this.list();
    if (!listing.ok) return listing;
    const matches: GrepMatch[] = [];
    const total = listing.value.entries.length;
    let done = 0;
    for (const entry of listing.value.entries) {
      if (job.signal?.aborted === true) return err(CANCELLED);
      const content = await this.show(entry, job.signal);
      if (!content.ok) {
        const fatal = ['cancelled', 'gpg-cancelled', 'gpg-not-found'].includes(content.error.kind);
        if (fatal) return err(content.error.kind === 'gpg-not-found' ? content.error : CANCELLED);
      } else {
        const lines = splitLines(content.value)
          .map((text, index) => ({ line: index + 1, text }))
          .filter(({ text }) => matcher(text))
          .map(({ line, text }) =>
            line === 1 ? { line, text: '', masked: true } : { line, text, masked: false },
          );
        if (lines.length > 0) matches.push({ path: entry, lines });
      }
      done += 1;
      job.onProgress?.(done, total);
    }
    return ok(matches);
  }

  /* --------------------------------------------------------------- init */

  /**
   * `pass init [--path=folder] gpg-id...`: writes the `.gpg-id` (or removes it
   * when `keyIds` is empty) and re-encrypts every entry it governs.
   */
  public async init(
    folder: FolderPath,
    keyIds: readonly GpgKeyId[],
    job: JobOptions = {},
  ): Async<{ reencrypted: number }> {
    const dir = this.resolve(this.dir, folder);
    if (!dir.ok) return dir;
    const idFile = path.join(dir.value, GPG_ID_FILE);
    const label = keyIds.join(', ');
    if (keyIds.length === 0) {
      if ((await pathKind(idFile)) !== 'file') {
        return err({ kind: 'invalid-argument', message: 'no .gpg-id to remove' });
      }
      const removed = await io(() => rm(idFile));
      if (!removed.ok) return removed;
      await this.pruneEmptyParents(dir.value);
      const committed = await this.commit(
        [idFile],
        `Deinitialize ${folder === '' ? '.' : folder}.`,
      );
      if (!committed.ok) return committed;
    } else {
      const written = await io(async () => {
        await mkdir(dir.value, { recursive: true });
        await writeFile(idFile, `${keyIds.join('\n')}\n`, 'utf8');
      });
      if (!written.ok) return written;
      const suffix = folder === '' ? '' : ` (${folder})`;
      const committed = await this.commit([idFile], `Set GPG id to ${label}${suffix}.`);
      if (!committed.ok) return committed;
    }
    const reencrypted = await this.reencrypt(dir.value, job);
    if (!reencrypted.ok) return reencrypted;
    if (reencrypted.value > 0) {
      const message =
        keyIds.length === 0
          ? `Reencrypt password store using inherited GPG id.`
          : `Reencrypt password store using new GPG id ${label}.`;
      const committed = await this.commit([dir.value], message);
      if (!committed.ok) return committed;
    }
    return ok({ reencrypted: reencrypted.value });
  }

  /** Re-encrypts the entries below `dir` that are not governed by a deeper `.gpg-id`. */
  private async reencrypt(dir: string, job: JobOptions): Async<number> {
    if ((await pathKind(dir)) !== 'dir') return ok(0);
    const entries: EntryPath[] = [];
    await this.walk(dir, entries, []);
    const governed: { file: string; to: Recipients }[] = [];
    for (const entry of entries) {
      const file = this.entryFile(entry);
      if (!file.ok) return file;
      const to = await this.recipientsForDir(path.dirname(file.value));
      if (!to.ok) return to;
      const deeper = to.value.definedIn?.startsWith(dir + path.sep) === true;
      if (!deeper) governed.push({ file: file.value, to: to.value });
    }
    let done = 0;
    for (const { file, to } of governed) {
      if (job.signal?.aborted === true) return err(CANCELLED);
      const plaintext = await this.gpg.decrypt(file, job.signal);
      if (!plaintext.ok) return plaintext;
      const written = await this.writeEncrypted(file, to, plaintext.value);
      if (!written.ok) return written;
      done += 1;
      job.onProgress?.(done, governed.length);
    }
    return ok(done);
  }

  /* ---------------------------------------------------------------- git */

  /** `pass git init`. */
  public async gitInit(): Async<null> {
    const made = await io(() => mkdir(this.dir, { recursive: true }));
    if (!made.ok) return made;
    const initialized = await this.git.init(this.dir, this.gpg.binary);
    if (!initialized.ok) return initialized;
    const first = await this.commit([this.dir], 'Add current contents of password store.');
    if (!first.ok) return first;
    const attributes = path.join(this.dir, '.gitattributes');
    const written = await io(() => writeFile(attributes, '*.gpg diff=gpg\n', 'utf8'));
    if (!written.ok) return written;
    return this.commit([attributes], 'Configure git repository for gpg file diff.');
  }
}
