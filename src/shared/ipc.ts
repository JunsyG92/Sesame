import { z } from 'zod';
import type { AppError } from './errors';
import type { Result } from './result';
import {
  AppStatusSchema,
  CopyOutcomeSchema,
  CopyTargetSchema,
  EntryViewSchema,
  GeneratedPreviewSchema,
  GeneratorOptionsSchema,
  GitCommitSchema,
  GitStatusSchema,
  GpgKeySchema,
  GrepMatchSchema,
  OtpCodeSchema,
  RecipientsInfoSchema,
  SettingsPatchSchema,
  SettingsSchema,
  StoreListingSchema,
  UsageHistorySchema,
} from './schemas';
import { EntryPathSchema, FolderPathSchema, GpgKeyIdSchema, PlainSecretSchema } from './types';

/**
 * Single source of truth for IPC. The preload whitelist, the main-process
 * handlers and the renderer client all derive their types from this contract;
 * every input is parsed with its schema in the main process before use.
 */
const none = z.void();
const done = z.null();
const jobId = z.string().regex(/^[a-zA-Z0-9-]{1,64}$/);
const insertKind = z.enum(['given', 'generated']);
const gitUrl = z.string().min(1).max(2048);

export const ipcContract = {
  /* application */
  'app:status': { input: none, output: AppStatusSchema },
  'app:openManager': { input: none, output: done },
  'app:hideLauncher': { input: none, output: done },
  'app:quit': { input: none, output: done },
  'app:secretVisible': { input: z.object({ visible: z.boolean() }), output: done },
  'app:chooseStoreDir': { input: none, output: z.string().nullable() },
  'app:chooseGpgBinary': { input: none, output: z.string().nullable() },
  'settings:get': { input: none, output: SettingsSchema },
  'settings:update': { input: SettingsPatchSchema, output: SettingsSchema },
  'history:get': { input: none, output: UsageHistorySchema },

  /* store (pass commands) */
  'store:list': { input: none, output: StoreListingSchema },
  'store:show': { input: z.object({ path: EntryPathSchema }), output: EntryViewSchema },
  'store:copy': {
    input: z.object({ path: EntryPathSchema, target: CopyTargetSchema }),
    output: CopyOutcomeSchema,
  },
  'store:openUrl': { input: z.object({ path: EntryPathSchema }), output: done },
  'store:insert': {
    input: z.object({
      path: EntryPathSchema,
      content: PlainSecretSchema,
      kind: insertKind,
      force: z.boolean(),
      copy: z.boolean(),
    }),
    output: done,
  },
  'store:insertFromClipboard': {
    input: z.object({ path: EntryPathSchema, force: z.boolean() }),
    output: done,
  },
  'store:generate': {
    input: z.object({
      path: EntryPathSchema,
      options: GeneratorOptionsSchema,
      inPlace: z.boolean(),
      force: z.boolean(),
      copy: z.boolean(),
    }),
    output: z.object({ entropyBits: z.number(), clearAfterSeconds: z.number() }),
  },
  'store:edit': {
    input: z.object({ path: EntryPathSchema, content: PlainSecretSchema }),
    output: done,
  },
  'store:remove': {
    input: z.object({ path: EntryPathSchema, recursive: z.boolean() }),
    output: done,
  },
  'store:move': {
    input: z.object({ from: EntryPathSchema, to: EntryPathSchema, force: z.boolean() }),
    output: done,
  },
  'store:duplicate': {
    input: z.object({ from: EntryPathSchema, to: EntryPathSchema, force: z.boolean() }),
    output: done,
  },
  'store:grep': {
    input: z.object({ id: jobId, pattern: z.string().min(1).max(256), regex: z.boolean() }),
    output: z.array(GrepMatchSchema),
  },
  'store:cancelJob': { input: z.object({ id: jobId }), output: done },
  'store:recipients': {
    input: z.object({ folder: FolderPathSchema }),
    output: RecipientsInfoSchema,
  },
  'store:init': {
    input: z.object({
      id: jobId,
      folder: FolderPathSchema,
      keyIds: z.array(GpgKeyIdSchema).max(64),
    }),
    output: z.object({ reencrypted: z.number() }),
  },
  'store:qr': {
    input: z.object({ path: EntryPathSchema, target: z.enum(['password', 'otp']) }),
    output: z.object({ dataUrl: z.string() }),
  },

  /* generator */
  'generator:preview': { input: GeneratorOptionsSchema, output: GeneratedPreviewSchema },

  /* clipboard */
  'clipboard:peek': {
    input: z.object({ reveal: z.boolean() }),
    output: z.object({ length: z.number(), text: PlainSecretSchema.nullable() }),
  },
  'clipboard:copyText': { input: z.object({ text: PlainSecretSchema }), output: CopyOutcomeSchema },

  /* otp (pass-otp) */
  'otp:code': { input: z.object({ path: EntryPathSchema }), output: OtpCodeSchema },
  'otp:setUri': {
    input: z.object({ path: EntryPathSchema, uri: PlainSecretSchema }),
    output: done,
  },
  'otp:importImage': { input: z.object({ path: EntryPathSchema }), output: done },
  'otp:importScreen': { input: z.object({ path: EntryPathSchema }), output: done },

  /* gpg */
  'gpg:listKeys': { input: z.object({ secretOnly: z.boolean() }), output: z.array(GpgKeySchema) },
  'gpg:generateKey': {
    input: z.object({ name: z.string().min(1).max(100), email: z.email().max(200) }),
    output: GpgKeySchema,
  },
  'gpg:importKey': { input: none, output: z.object({ imported: z.number() }) },
  'gpg:reloadAgent': { input: none, output: done },

  /* git */
  'git:status': { input: none, output: GitStatusSchema },
  'git:init': { input: none, output: done },
  'git:pull': { input: none, output: z.object({ output: z.string() }) },
  'git:push': { input: none, output: z.object({ output: z.string() }) },
  'git:log': {
    input: z.object({ limit: z.number().int().min(1).max(500) }),
    output: z.array(GitCommitSchema),
  },
  'git:clone': { input: z.object({ url: gitUrl }), output: done },
  'git:setRemote': { input: z.object({ url: gitUrl }), output: done },
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>;

export type IpcChannel = keyof typeof ipcContract;
export const IPC_CHANNELS: readonly IpcChannel[] = Object.keys(ipcContract).filter(
  (key): key is IpcChannel => key in ipcContract,
);

export type IpcInput<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.infer<(typeof ipcContract)[C]['output']>;
export type IpcResult<C extends IpcChannel> = Result<IpcOutput<C>, AppError>;
// `void` inputs make the argument optional at call sites.
export type IpcArgs<C extends IpcChannel> = undefined extends IpcInput<C> ? [] : [IpcInput<C>];

/* Events pushed from the main process to renderers. */
export const ipcEvents = {
  'store:changed': StoreListingSchema,
  'status:changed': AppStatusSchema,
  'settings:changed': SettingsSchema,
  'history:changed': UsageHistorySchema,
  'launcher:shown': z.null(),
  'app:lock': z.null(),
  'clipboard:countdown': z.object({ remaining: z.number() }),
  'job:progress': z.object({ id: z.string(), done: z.number(), total: z.number() }),
} as const satisfies Record<string, z.ZodType>;

export type IpcEvent = keyof typeof ipcEvents;
export const IPC_EVENTS: readonly IpcEvent[] = Object.keys(ipcEvents).filter(
  (key): key is IpcEvent => key in ipcEvents,
);
export type IpcEventPayload<E extends IpcEvent> = z.infer<(typeof ipcEvents)[E]>;

/** The API exposed on `window.sesame` by the preload script. */
export interface SesameApi {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>;
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void;
}

export const isIpcChannel = (value: string): value is IpcChannel => value in ipcContract;
export const isIpcEvent = (value: string): value is IpcEvent => value in ipcEvents;
