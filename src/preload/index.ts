import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_EVENT_PREFIX, IPC_INVOKE, ipcEventNames, type StellioBridge } from '@shared/ipc/bridge';

// Kept deliberately thin: validation happens in main, the trust boundary.
const bridge: StellioBridge = {
  invoke: (channel, input) => ipcRenderer.invoke(IPC_INVOKE, channel, input),
  on: (event, listener) => {
    if (!ipcEventNames.includes(event)) throw new Error('Unknown event');
    const channel = IPC_EVENT_PREFIX + event;
    // Never hand the raw IpcRendererEvent (it exposes `sender`) to page code.
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('stellio', bridge);
