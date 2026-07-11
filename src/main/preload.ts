import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export interface IElectronAPI {
  readDirectory: (dirPath: string) => Promise<any>;
  ensureDir: (dirPath: string) => Promise<any>;
  getHomeDir: () => Promise<string>;
  showOpenDialog: (options: any) => Promise<any>;
  showSaveDialog: (options: any) => Promise<any>;
  readFileContent: (filePath: string) => Promise<any>;
  writeFileContent: (filePath: string, content: string) => Promise<any>;
  proxyFetch: (url: string, options?: any) => Promise<any>;
  windowControls: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
  };
  windowState: {
    isMaximized: () => Promise<boolean>;
  };
  onWindowStateChange: (callback: (state: { isMaximized: boolean }) => void) => () => void;
  checkForUpdates: () => Promise<any>;
  getAppVersion: () => Promise<string>;
  downloadAndInstallUpdate: (opts: { releaseUrl: string }) => Promise<any>;
  onUpdateDownloadProgress: (cb: (data: { progress: number; receivedBytes: number; totalBytes: number }) => void) => () => void;
  openExternal: (url: string) => Promise<any>;
  closeWindow: () => void;
}

contextBridge.exposeInMainWorld('api', {
  readDirectory: (dirPath: string) => ipcRenderer.invoke('readDirectory', dirPath),
  ensureDir: (dirPath: string) => ipcRenderer.invoke('ensureDirectory', dirPath),
  getHomeDir: () => ipcRenderer.invoke('getHomeDir'),
  showOpenDialog: (options: any) => ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options: any) => ipcRenderer.invoke('show-save-dialog', options),
  readFileContent: (filePath: string) => ipcRenderer.invoke('read-file-content', filePath),
  writeFileContent: (filePath: string, content: string) => ipcRenderer.invoke('write-file-content', filePath, content),
  proxyFetch: (url: string, options?: any) => ipcRenderer.invoke('proxy-fetch', url, options),
  windowControls: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
  },
  windowState: {
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  },
  onWindowStateChange: (callback: (state: { isMaximized: boolean }) => void) => {
    const handler = (_event: IpcRendererEvent, state: { isMaximized: boolean }) => callback(state);
    ipcRenderer.on('window-state-changed', handler);
    return () => ipcRenderer.removeListener('window-state-changed', handler);
  },
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  downloadAndInstallUpdate: (opts: any) => ipcRenderer.invoke('download-and-install-update', opts),
  onUpdateDownloadProgress: (cb: any) => {
    const handler = (_event: IpcRendererEvent, data: any) => cb(data);
    ipcRenderer.on('update-download-progress', handler);
    return () => ipcRenderer.removeListener('update-download-progress', handler);
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  closeWindow: () => ipcRenderer.send('window-close'),
} as IElectronAPI);

declare global {
  interface Window {
    api: IElectronAPI;
  }
}
