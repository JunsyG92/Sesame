import { describe, expect, it } from 'vitest';
import { dispatch } from '../../../src/main/ipc';
import type { Handlers } from '../../../src/main/services';
import {
  IPC_CHANNELS,
  IPC_EVENTS,
  ipcContract,
  isIpcChannel,
  isIpcEvent,
} from '../../../src/shared/ipc';

const echo = (channel: string) => (input: unknown) => {
  if (channel === 'app:quit') throw new TypeError('boom: hunter2');
  return Promise.resolve({ ok: true, value: { channel, input } });
};
// Test double: every handler echoes its validated input.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions
const handlers = Object.fromEntries(IPC_CHANNELS.map((c) => [c, echo(c)])) as unknown as Handlers;

describe('IPC dispatch', () => {
  const ctx = { senderId: 1 };

  it('exposes every contract channel and event', () => {
    expect(IPC_CHANNELS).toEqual(Object.keys(ipcContract));
    expect(IPC_CHANNELS).toContain('store:copy');
    expect(IPC_EVENTS).toContain('store:changed');
    expect(isIpcChannel('store:show')).toBe(true);
    expect(isIpcChannel('constructor')).toBe(false);
    expect(isIpcEvent('app:lock')).toBe(true);
    expect(isIpcEvent('__proto__')).toBe(false);
  });

  it('validates inputs with the contract schemas before calling a handler', async () => {
    expect(await dispatch(handlers, 'store:show', { path: 'web/a' }, ctx)).toEqual({
      ok: true,
      value: { channel: 'store:show', input: { path: 'web/a' } },
    });
    expect(await dispatch(handlers, 'store:show', { path: '../etc/passwd' }, ctx)).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'invalid input: path' },
    });
    expect(await dispatch(handlers, 'store:show', 'web/a', ctx)).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'invalid input' },
    });
    expect(
      await dispatch(
        handlers,
        'store:init',
        { id: 'x', folder: '', keyIds: ['--homedir=/tmp'] },
        ctx,
      ),
    ).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'invalid input: keyIds.0' },
    });
    expect(
      await dispatch(handlers, 'store:grep', { id: '../x', pattern: 'a', regex: false }, ctx),
    ).toMatchObject({ ok: false });
    expect(await dispatch(handlers, 'settings:update', { theme: 'neon' }, ctx)).toMatchObject({
      ok: false,
    });
    expect(await dispatch(handlers, 'app:status', undefined, ctx)).toMatchObject({ ok: true });
  });

  it('rejects unknown channels', async () => {
    expect(await dispatch(handlers, 'fs:readFile', {}, ctx)).toEqual({
      ok: false,
      error: { kind: 'invalid-argument', message: 'unknown channel' },
    });
    expect(await dispatch(handlers, '__proto__', {}, ctx)).toMatchObject({ ok: false });
  });

  it('never leaks exception messages (they may contain secrets)', async () => {
    const result = await dispatch(handlers, 'app:quit', undefined, ctx);
    expect(result).toEqual({ ok: false, error: { kind: 'unexpected', message: 'TypeError' } });
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});
