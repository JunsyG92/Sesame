import type { AppError } from '../shared/errors';
import {
  ipcContract,
  isIpcChannel,
  type IpcChannel,
  type IpcInput,
  type IpcResult,
} from '../shared/ipc';
import { err, type Result } from '../shared/result';
import type { CallContext, Handlers } from './services';

/**
 * Validates and routes one IPC request. Inputs are parsed with the contract's
 * zod schema before reaching a handler; unexpected exceptions are reduced to
 * their class name so that no payload (possibly secret) leaks in an error.
 */
async function invoke<C extends IpcChannel>(
  handlers: Handlers,
  channel: C,
  rawInput: unknown,
  context: CallContext,
): Promise<IpcResult<C>> {
  const parsed = ipcContract[channel].input.safeParse(rawInput);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join('.') ?? '';
    return err({
      kind: 'invalid-argument',
      message: `invalid input${where === '' ? '' : `: ${where}`}`,
    });
  }
  // The schema of channel C produces exactly IpcInput<C>; TypeScript cannot follow
  // that correlation through the indexed access, hence this single boundary assertion.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const input = parsed.data as IpcInput<C>;
  return handlers[channel](input, context);
}

export async function dispatch(
  handlers: Handlers,
  channel: string,
  rawInput: unknown,
  context: CallContext,
): Promise<Result<unknown, AppError>> {
  if (!isIpcChannel(channel)) {
    return err({ kind: 'invalid-argument', message: 'unknown channel' });
  }
  try {
    return await invoke(handlers, channel, rawInput, context);
  } catch (error) {
    return err({ kind: 'unexpected', message: error instanceof Error ? error.name : 'Error' });
  }
}
