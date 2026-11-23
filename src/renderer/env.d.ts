import type { SesameApi } from '../shared/ipc';

declare global {
  interface Window {
    readonly sesame: SesameApi;
  }
}
