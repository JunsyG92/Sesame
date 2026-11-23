import { z } from 'zod';
import { PATH_ERROR_REASONS } from './entryPath';

/**
 * Every expected failure is an explicit, serialisable variant. Messages carried
 * here come from tool diagnostics (stderr) and never contain decrypted data.
 */
export const AppErrorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('gpg-not-found') }),
  z.object({ kind: z.literal('gpg-failed'), message: z.string() }),
  z.object({ kind: z.literal('gpg-no-secret-key') }),
  z.object({ kind: z.literal('gpg-key-unusable'), message: z.string() }),
  z.object({ kind: z.literal('gpg-cancelled') }),
  z.object({ kind: z.literal('store-missing') }),
  z.object({ kind: z.literal('store-not-initialized') }),
  z.object({ kind: z.literal('entry-not-found'), path: z.string() }),
  z.object({ kind: z.literal('entry-exists'), path: z.string() }),
  z.object({ kind: z.literal('invalid-path'), reason: z.enum(PATH_ERROR_REASONS) }),
  z.object({ kind: z.literal('invalid-argument'), message: z.string() }),
  z.object({ kind: z.literal('git-not-found') }),
  z.object({ kind: z.literal('not-a-git-repo') }),
  z.object({ kind: z.literal('git-no-remote') }),
  z.object({ kind: z.literal('git-conflict') }),
  z.object({ kind: z.literal('git-failed'), message: z.string() }),
  z.object({ kind: z.literal('otp-missing') }),
  z.object({ kind: z.literal('otp-invalid') }),
  z.object({ kind: z.literal('qr-not-found') }),
  z.object({ kind: z.literal('clipboard-empty') }),
  z.object({ kind: z.literal('shortcut-conflict'), accelerator: z.string() }),
  z.object({ kind: z.literal('cancelled') }),
  z.object({ kind: z.literal('io'), message: z.string() }),
  z.object({ kind: z.literal('unexpected'), message: z.string() }),
]);
export type AppError = z.infer<typeof AppErrorSchema>;
export type AppErrorKind = AppError['kind'];
