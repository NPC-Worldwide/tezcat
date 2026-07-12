export interface IElectronAPI {
  readDirectory: (dirPath: string) => Promise<any>;
  ensureDir: (dirPath: string) => Promise<any>;
  getHomeDir: () => Promise<string>;
  showOpenDialog: (options: any) => Promise<any>;
  showSaveDialog: (options: any) => Promise<any>;
  readFileContent: (filePath: string) => Promise<any>;
  writeFileContent: (filePath: string, content: string) => Promise<any>;
  proxyFetch: (url: string, options?: any) => Promise<any>;
  proxyTile: (url: string) => Promise<{ ok: boolean; status: number; data?: string; error?: string }>;
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
declare global {
  interface Window {
    api: IElectronAPI;
  }
}
export {};
