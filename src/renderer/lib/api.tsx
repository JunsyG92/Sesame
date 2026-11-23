import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppError } from '../../shared/errors';
import type { IpcEvent, IpcEventPayload, SesameApi } from '../../shared/ipc';
import type { Result } from '../../shared/result';

const ApiContext = createContext<SesameApi | null>(null);

/** Provides the IPC client; tests inject a fake implementation. */
export function ApiProvider({ api, children }: { api: SesameApi; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): SesameApi {
  const api = useContext(ApiContext);
  // eslint-disable-next-line security/detect-possible-timing-attacks -- not a secret comparison
  if (api === null) throw new Error('ApiProvider missing');
  return api;
}

/** Subscribes to a main-process event for the lifetime of the component. */
export function useEvent<E extends IpcEvent>(
  event: E,
  listener: (payload: IpcEventPayload<E>) => void,
): void {
  const api = useApi();
  useEffect(() => api.on(event, listener), [api, event, listener]);
}

/**
 * State initialised by an IPC query and kept up to date by the matching
 * pushed event (listing, settings, status, history).
 */
export function useLive<E extends IpcEvent>(
  event: E,
  load: (api: SesameApi) => Promise<Result<IpcEventPayload<E>, AppError>>,
): IpcEventPayload<E> | null {
  const api = useApi();
  const [value, setValue] = useState<IpcEventPayload<E> | null>(null);
  useEffect(() => {
    let alive = true;
    void load(api).then((result) => {
      if (alive && result.ok) setValue(() => result.value);
    });
    const off = api.on(event, (payload) => {
      setValue(() => payload);
    });
    return () => {
      alive = false;
      off();
    };
    // `load` is a module-level function at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, event]);
  return value;
}
