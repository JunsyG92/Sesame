import { z } from 'zod';
import { hasControlCharacter, isValidEntryPath } from './entryPath';

/**
 * Branded types for risky values. A brand can only be obtained by going
 * through the matching schema/constructor, so an unvalidated path or an
 * arbitrary string cannot be passed where a validated one is required.
 */
export const EntryPathSchema = z
  .string()
  .refine(isValidEntryPath, { message: 'invalid entry path' })
  .brand<'EntryPath'>();
export type EntryPath = z.infer<typeof EntryPathSchema>;

/** A folder inside the store; the empty string is the store root. */
export const FolderPathSchema = z
  .string()
  .refine((value) => value === '' || isValidEntryPath(value), { message: 'invalid folder path' })
  .brand<'FolderPath'>();
export type FolderPath = z.infer<typeof FolderPathSchema>;

/**
 * A GnuPG recipient: fingerprint, key id, e-mail or user id. It must never
 * look like a command-line option, since it is passed to `gpg --recipient`.
 */
export function isValidGpgKeyId(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  if (value.startsWith('-') || hasControlCharacter(value)) return false;
  return value.trim() === value;
}
export const GpgKeyIdSchema = z
  .string()
  .refine(isValidGpgKeyId, { message: 'invalid gpg key id' })
  .brand<'GpgKeyId'>();
export type GpgKeyId = z.infer<typeof GpgKeyIdSchema>;

/** Decrypted material. Never log it, never put it on a command line. */
export const PlainSecretSchema = z
  .string()
  .max(1024 * 1024)
  .brand<'PlainSecret'>();
export type PlainSecret = z.infer<typeof PlainSecretSchema>;

export const asPlainSecret = (value: string): PlainSecret => PlainSecretSchema.parse(value);
export const asFolderPath = (value: string): FolderPath => FolderPathSchema.parse(value);
export const ROOT_FOLDER = asFolderPath('');
