import { contextBridge, ipcRenderer } from 'electron';

export interface IElectronAPI {
  readDirectory: (dirPath: string) => Promise<any>;
  ensureDir: (dirPath: string) => Promise<any>;
  getHomeDir: () => Promise<string>;
  showOpenDialog: (options: any) => Promise<any>;
  showSaveDialog: (options: any) => Promise<any>;
  readFileContent: (filePath: string) => Promise<any>;
  writeFileContent: (filePath: string, content: string) => Promise<any>;
  proxyFetch: (url: string, options?: any) => Promise<any>;
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
} as IElectronAPI);

declare global {
  interface Window {
    api: IElectronAPI;
  }
}
