import { useCallback, useEffect, useState } from 'react';
import { useApi } from './api';

/** Tracks progress events of a long job (grep, re-encryption) started by this view. */
export function useJob(): {
  id: string;
  progress: { done: number; total: number } | null;
  start: () => string;
  reset: () => void;
} {
  const api = useApi();
  const [id, setId] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  useEffect(
    () =>
      api.on('job:progress', (event) => {
        if (event.id === id) setProgress({ done: event.done, total: event.total });
      }),
    [api, id],
  );
  const start = useCallback(() => {
    const next = `job-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
    setId(next);
    setProgress(null);
    return next;
  }, []);
  const reset = useCallback(() => {
    setId('');
    setProgress(null);
  }, []);
  return { id, progress, start, reset };
}
