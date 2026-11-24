import { z } from 'zod';
import { EntryPathSchema, PlainSecretSchema } from './types';

/* ---------------------------------------------------------------- generator */

export const CharsOptionsSchema = z.object({
  mode: z.literal('chars'),
  length: z.number().int().min(8).max(128),
  upper: z.boolean(),
  lower: z.boolean(),
  digits: z.boolean(),
  symbols: z.boolean(),
  excludeAmbiguous: z.boolean(),
  exclude: z.string().max(128),
});
export const PassphraseOptionsSchema = z.object({
  mode: z.literal('passphrase'),
  words: z.number().int().min(3).max(12),
  separator: z.string().max(3),
  capitalize: z.boolean(),
  addDigit: z.boolean(),
});
export const PinOptionsSchema = z.object({
  mode: z.literal('pin'),
  length: z.number().int().min(4).max(12),
});
export const GeneratorOptionsSchema = z.discriminatedUnion('mode', [
  CharsOptionsSchema,
  PassphraseOptionsSchema,
  PinOptionsSchema,
]);
export type CharsOptions = z.infer<typeof CharsOptionsSchema>;
export type PassphraseOptions = z.infer<typeof PassphraseOptionsSchema>;
export type PinOptions = z.infer<typeof PinOptionsSchema>;
export type GeneratorOptions = z.infer<typeof GeneratorOptionsSchema>;
export type GeneratorMode = GeneratorOptions['mode'];

export const GeneratedPreviewSchema = z.object({
  password: PlainSecretSchema,
  entropyBits: z.number(),
  score: z.number().int().min(0).max(4),
});
export type GeneratedPreview = z.infer<typeof GeneratedPreviewSchema>;

export const PresetSchema = z.object({
  name: z.string().min(1).max(40),
  options: GeneratorOptionsSchema,
});
export type Preset = z.infer<typeof PresetSchema>;

/* ----------------------------------------------------------------- settings */

export const ThemeSchema = z.enum(['system', 'light', 'dark']);
export const LanguageSchema = z.enum(['system', 'fr', 'en']);
export type Language = z.infer<typeof LanguageSchema>;
export type Locale = 'fr' | 'en';

export const SettingsSchema = z.object({
  shortcut: z.string().min(1).max(64),
  /** null → `$PASSWORD_STORE_DIR` or `~/.password-store`. */
  storeDir: z.string().max(4096).nullable(),
  /** null → auto-detection. */
  gpgPath: z.string().max(4096).nullable(),
  /** null → `$PASSWORD_STORE_CLIP_TIME` or 45 s. */
  clipTime: z.number().int().min(5).max(600).nullable(),
  generator: GeneratorOptionsSchema,
  presets: z.array(PresetSchema).max(20),
  autoStart: z.boolean(),
  theme: ThemeSchema,
  language: LanguageSchema,
  /** 0 disables the auto-lock. */
  autoLockMinutes: z.number().int().min(0).max(720),
  reloadAgentOnLock: z.boolean(),
  autoUpdate: z.boolean(),
  /** System notifications when rotated passwords expire. */
  rotationNotifications: z.boolean(),
  /** Days before the deadline from which a password is reported as "expiring soon". */
  rotationWarningDays: z.number().int().min(0).max(90),
});
export type Settings = z.infer<typeof SettingsSchema>;
export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/* -------------------------------------------------------------------- store */

export const FieldSchema = z.object({
  key: z.string(),
  value: z.string(),
  /** 1-based line number inside the entry (like `pass show --clip=N`). */
  line: z.number().int(),
});
export type Field = z.infer<typeof FieldSchema>;

export const RotationStateSchema = z.enum(['ok', 'soon', 'expired']);
export type RotationState = z.infer<typeof RotationStateSchema>;

export const RotationItemSchema = z.object({
  path: EntryPathSchema,
  /** `rotation:` value, e.g. `2m`. */
  interval: z.string(),
  changedAt: z.string().nullable(),
  dueAt: z.string().nullable(),
  daysLeft: z.number().int().nullable(),
  state: RotationStateSchema,
});
export type RotationItem = z.infer<typeof RotationItemSchema>;

export const EntryRotationSchema = z.object({
  interval: z.string().nullable(),
  changedAt: z.string().nullable(),
  changeUrl: z.string().nullable(),
  /** Computed deadline; null when the entry is not rotated (or its interval is invalid). */
  status: z
    .object({
      dueAt: z.string().nullable(),
      daysLeft: z.number().int().nullable(),
      state: RotationStateSchema,
    })
    .nullable(),
});
export type EntryRotation = z.infer<typeof EntryRotationSchema>;

export const ManagerTabSchema = z.enum([
  'passwords',
  'rotation',
  'grep',
  'keys',
  'git',
  'settings',
]);
export type ManagerTab = z.infer<typeof ManagerTabSchema>;

export const EntryViewSchema = z.object({
  path: EntryPathSchema,
  password: PlainSecretSchema,
  raw: PlainSecretSchema,
  fields: z.array(FieldSchema),
  notes: z.string(),
  login: z.string().nullable(),
  url: z.string().nullable(),
  hasOtp: z.boolean(),
  rotation: EntryRotationSchema,
});
export type EntryView = z.infer<typeof EntryViewSchema>;

export const StoreListingSchema = z.object({
  entries: z.array(EntryPathSchema),
  folders: z.array(z.string()),
});
export type StoreListing = z.infer<typeof StoreListingSchema>;

export const CopyTargetSchema = z.discriminatedUnion('what', [
  z.object({ what: z.literal('password') }),
  z.object({ what: z.literal('login') }),
  z.object({ what: z.literal('otp') }),
  z.object({ what: z.literal('line'), line: z.number().int().min(1).max(10000) }),
]);
export type CopyTarget = z.infer<typeof CopyTargetSchema>;

export const CopyOutcomeSchema = z.object({
  what: z.enum(['password', 'login', 'otp', 'line']),
  clearAfterSeconds: z.number(),
});
export type CopyOutcome = z.infer<typeof CopyOutcomeSchema>;

export const GrepMatchSchema = z.object({
  path: EntryPathSchema,
  /** Matching lines; the first (password) line is never returned in clear. */
  lines: z.array(z.object({ line: z.number().int(), text: z.string(), masked: z.boolean() })),
});
export type GrepMatch = z.infer<typeof GrepMatchSchema>;

export const RecipientsInfoSchema = z.object({
  ids: z.array(z.string()),
  /** Folder holding the effective `.gpg-id` (null when none exists). */
  definedIn: z.string().nullable(),
  own: z.boolean(),
});
export type RecipientsInfo = z.infer<typeof RecipientsInfoSchema>;

export const OtpCodeSchema = z.object({
  code: z.string(),
  period: z.number(),
  remaining: z.number(),
});
export type OtpCode = z.infer<typeof OtpCodeSchema>;

/* ---------------------------------------------------------------------- gpg */

export const GpgKeySchema = z.object({
  fingerprint: z.string(),
  keyId: z.string(),
  uids: z.array(z.string()),
  canEncrypt: z.boolean(),
  hasSecret: z.boolean(),
  expired: z.boolean(),
  created: z.number().nullable(),
  expires: z.number().nullable(),
});
export type GpgKey = z.infer<typeof GpgKeySchema>;

/* ---------------------------------------------------------------------- git */

export const GitStatusSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().nullable(),
  remote: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
  changes: z.array(z.string()),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

export const GitCommitSchema = z.object({
  hash: z.string(),
  author: z.string(),
  date: z.string(),
  subject: z.string(),
});
export type GitCommit = z.infer<typeof GitCommitSchema>;

/* ------------------------------------------------------------------- status */

export const AppStatusSchema = z.object({
  platform: z.enum(['linux', 'win32', 'darwin']),
  wayland: z.boolean(),
  version: z.string(),
  locale: z.enum(['fr', 'en']),
  gpg: z.object({ path: z.string().nullable(), version: z.string().nullable() }),
  store: z.object({
    dir: z.string(),
    exists: z.boolean(),
    initialized: z.boolean(),
    isGit: z.boolean(),
  }),
  shortcut: z.object({ accelerator: z.string(), registered: z.boolean() }),
});
export type AppStatus = z.infer<typeof AppStatusSchema>;

export const UsageHistorySchema = z.record(
  z.string(),
  z.object({ count: z.number().int().min(0), last: z.number() }),
);
export type UsageHistory = z.infer<typeof UsageHistorySchema>;
