import nodePath from 'node:path';
import type { AppError } from '../../shared/errors';
import { validateEntryPath, type PathMode } from '../../shared/entryPath';
import { err, ok, type Result } from '../../shared/result';
import { EntryPathSchema, type EntryPath, type FolderPath } from '../../shared/types';

/** Minimal subset of `node:path` so that both flavours can be tested anywhere. */
export type PathApi = Pick<typeof nodePath, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

/** Validates and normalises user input into a branded entry name. */
export function parseEntryPath(input: string, mode: PathMode = 'new'): Result<EntryPath, AppError> {
  const validated = validateEntryPath(input, mode);
  if (!validated.ok) return err({ kind: 'invalid-path', reason: validated.error });
  const branded = EntryPathSchema.safeParse(validated.value);
  /* v8 ignore next -- the brand schema accepts everything validateEntryPath accepts */
  if (!branded.success) return err({ kind: 'invalid-path', reason: 'forbidden-character' });
  return ok(branded.data);
}

/** Portability gate for names Sesame is about to create. */
export function checkCreatable(path: EntryPath): Result<EntryPath, AppError> {
  return parseEntryPath(path, 'new');
}

/**
 * Joins a validated name to the store directory and proves the result is
 * strictly inside it. This is the last line of defence against traversal,
 * independent from the lexical validation of names.
 */
export function resolveInStore(
  storeDir: string,
  name: EntryPath | FolderPath,
  suffix = '',
  pathApi: PathApi = nodePath,
): Result<string, AppError> {
  const root = pathApi.resolve(storeDir);
  if (name === '') return ok(suffix === '' ? root : pathApi.resolve(root, suffix));
  // Windows silently rewrites names (trailing dots/spaces, `c:` drive-relative
  // paths, device names): there, only fully portable names are addressable.
  if (pathApi.sep === '\\') {
    const portable = validateEntryPath(name, 'new');
    if (!portable.ok) return err({ kind: 'invalid-path', reason: portable.error });
  }
  const target = pathApi.resolve(root, ...name.split('/')) + suffix;
  const relative = pathApi.relative(root, target);
  const escapes =
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relative);
  if (escapes) return err({ kind: 'invalid-path', reason: 'traversal' });
  return ok(target);
}

export const GPG_EXTENSION = '.gpg';
export const GPG_ID_FILE = '.gpg-id';

export function entryFile(storeDir: string, path: EntryPath): Result<string, AppError> {
  return resolveInStore(storeDir, path, GPG_EXTENSION);
}

/** Converts a path relative to the store (OS separators) to an entry name. */
export function entryNameFromRelative(relativeFile: string): EntryPath | null {
  if (!relativeFile.endsWith(GPG_EXTENSION)) return null;
  const name = relativeFile.slice(0, -GPG_EXTENSION.length).split(nodePath.sep).join('/');
  const parsed = parseEntryPath(name, 'existing');
  return parsed.ok && parsed.value === name ? parsed.value : null;
}
