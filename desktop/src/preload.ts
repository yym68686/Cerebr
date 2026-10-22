import { contextBridge, ipcRenderer } from 'electron';
if (process.isMainFrame)
    contextBridge.exposeInMainWorld('cerebrDesktop', {
        platform: process.platform,
        send: (message: unknown) => ipcRenderer.send('desktop:send', message),
        status: () => ipcRenderer.invoke('desktop:status'),
        pairing: () => ipcRenderer.invoke('desktop:pairing'),
        browserRequest: (payload: unknown) => ipcRenderer.invoke('desktop:browser-request', payload),
        windowAction: (action: string) => ipcRenderer.send('desktop:window', action),
        onSelectAll: (callback: () => void) => {
            const listener = () => callback();
            ipcRenderer.on('desktop:select-all', listener);
            return () => ipcRenderer.removeListener('desktop:select-all', listener);
        },
        onFind: (callback: () => void) => {
            const listener = () => callback();
            ipcRenderer.on('desktop:find', listener);
            return () => ipcRenderer.removeListener('desktop:find', listener);
        },
        updates: {
            status: () => ipcRenderer.invoke('desktop:update-status'),
            check: () => ipcRenderer.invoke('desktop:update-check'),
            ready: () => ipcRenderer.invoke('desktop:update-ready'),
            saveFailed: () => ipcRenderer.send('desktop:update-save-failed'),
            subscribe: (callback: (status: unknown) => void) => {
                const listener = (_event: unknown, status: unknown) => callback(status);
                ipcRenderer.on('desktop:update-status', listener);
                return () => ipcRenderer.removeListener('desktop:update-status', listener);
            },
        },
        onBrowserEvent: (callback: (event: unknown) => void) => {
            const listener = (_event: unknown, event: unknown) => callback(event);
            ipcRenderer.on('desktop:browser-event', listener);
            return () => ipcRenderer.removeListener('desktop:browser-event', listener);
        },
        onMessage: (callback: (message: unknown) => void) => {
            const listener = (_event: unknown, message: unknown) => callback(message);
            ipcRenderer.on('desktop:sync', listener);
            return () => ipcRenderer.removeListener('desktop:sync', listener);
        },
        onStatus: (callback: (status: unknown) => void) => {
            const listener = (_event: unknown, status: unknown) => callback(status);
            ipcRenderer.on('desktop:status', listener);
            return () => ipcRenderer.removeListener('desktop:status', listener);
        },
    });
