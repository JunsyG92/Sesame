import { contextBridge, ipcRenderer } from 'electron';
import {
  isIpcChannel,
  isIpcEvent,
  type IpcArgs,
  type IpcChannel,
  type IpcEvent,
  type IpcEventPayload,
  type IpcResult,
  type SesameApi,
} from '../shared/ipc';

/**
 * The only bridge between the sandboxed renderer and the main process: a
 * typed `invoke` restricted to the channels of the shared contract, and a
 * typed event subscription. `ipcRenderer` itself is never exposed.
 */
const api: SesameApi = {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
    if (!isIpcChannel(channel)) return Promise.reject(new Error('unknown channel'));
    // `ipcRenderer.invoke` is untyped; the main process answers every contract
    // channel with the matching `IpcResult`, which is what this assertion states.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return ipcRenderer.invoke('sesame:invoke', channel, args[0]) as Promise<IpcResult<C>>;
  },
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void {
    if (!isIpcEvent(event)) throw new Error('unknown event');
    const wrapped = (_event: Electron.IpcRendererEvent, payload: IpcEventPayload<E>): void => {
      listener(payload);
    };
    ipcRenderer.on(`sesame:event:${event}`, wrapped);
    return () => {
      ipcRenderer.removeListener(`sesame:event:${event}`, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('sesame', api);
