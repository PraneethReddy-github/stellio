/// <reference types="vite/client" />
import type { StellioBridge } from '@shared/ipc/bridge';

declare global {
  interface Window {
    stellio: StellioBridge;
  }
}
