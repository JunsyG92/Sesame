import { useCallback, useEffect, useState } from 'react';
import type { AppStatus, Settings, StoreListing, UsageHistory } from '../../shared/schemas';
import type { SesameApi } from '../../shared/ipc';
import { useLive } from './api';

const loadListing = (api: SesameApi) => api.invoke('store:list');
const loadHistory = (api: SesameApi) => api.invoke('history:get');
const loadSettings = (api: SesameApi) => api.invoke('settings:get');
const loadStatus = (api: SesameApi) => api.invoke('app:status');
const EMPTY_LISTING: StoreListing = { entries: [], folders: [] };
const EMPTY_HISTORY: UsageHistory = {};

export function useListing(): StoreListing {
  return useLive('store:changed', loadListing) ?? EMPTY_LISTING;
}

export function useHistory(): UsageHistory {
  return useLive('history:changed', loadHistory) ?? EMPTY_HISTORY;
}

export function useSettings(): Settings | null {
  return useLive('settings:changed', loadSettings);
}

export function useStatus(): AppStatus | null {
  return useLive('status:changed', loadStatus);
}

/** Applies the theme setting (system/light/dark) to the document. */
export function useTheme(theme: Settings['theme'] | undefined): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const dark = theme === 'dark' || (theme !== 'light' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => {
      media.removeEventListener('change', apply);
    };
  }, [theme]);
}

export interface Toast {
  readonly id: number;
  readonly tone: 'info' | 'success' | 'error';
  readonly text: string;
}

/** Short-lived notifications (copy confirmations, errors). */
export function useToasts(): {
  toasts: Toast[];
  push: (tone: Toast['tone'], text: string) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-2), { id, tone, text }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3500);
  }, []);
  return { toasts, push };
}
