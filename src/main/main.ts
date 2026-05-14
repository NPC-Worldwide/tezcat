import { app, BrowserWindow, ipcMain, dialog, protocol } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const IS_DEV = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
const BACKEND_PORT = IS_DEV ? '7141' : '5141';
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

protocol.registerSchemesAsPrivileged([{
  scheme: 'media',
  privileges: { standard: true, supportFetchAPI: true, stream: true, secure: true, corsEnabled: true }
}]);

let backendProcess: ReturnType<typeof spawn> | null = null;

function killBackendProcess() {
  if (!backendProcess) return;
  console.log('[Main] Killing backend process');
  if (process.platform === 'win32') {
    try { require('child_process').execSync(`taskkill /F /T /PID ${backendProcess.pid}`, { stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(-backendProcess.pid, 'SIGTERM'); } catch {}
  }
  backendProcess = null;
}

function spawnBackendProcess(pythonPath: string, args: string[], env: Record<string, string>) {
  console.log(`[Main] Spawning backend: ${pythonPath} ${args.join(' ')}`);
  const proc = spawn(pythonPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    env,
  });
  proc.stdout.on('data', (d) => console.log('[Backend stdout]', d.toString().trim()));
  proc.stderr.on('data', (d) => console.error('[Backend stderr]', d.toString().trim()));
  proc.on('error', (err) => console.error('[Backend error]', err.message));
  proc.on('close', (code) => console.log(`[Backend] exited with code ${code}`));
  return proc;
}

async function waitForServer(maxAttempts = 60, delay = 1000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${BACKEND_URL}/api/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) { console.log(`[Main] Backend ready (attempt ${i})`); return true; }
    } catch {}
    await new Promise(r => setTimeout(r, delay));
  }
  console.error('[Main] Backend failed to start');
  return false;
}

function getPythonPath(): string | null {
  const candidates = [
    path.join(os.homedir(), '.npcsh', 'venv', 'bin', 'python3'),
    path.join(os.homedir(), '.npcsh', 'venv', 'Scripts', 'python.exe'),
    path.join(os.homedir(), '.venv', 'bin', 'python3'),
    path.join(os.homedir(), '.venv', 'Scripts', 'python.exe'),
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try {
    const which = require('child_process').execSync('which python3 || which python', { encoding: 'utf8' }).trim();
    if (which) return which;
  } catch {}
  return null;
}

function getBackendPythonPath(): string | null {
  const rc = path.join(os.homedir(), '.npcshrc');
  try {
    if (fs.existsSync(rc)) {
      const content = fs.readFileSync(rc, 'utf8');
      const m = content.match(/BACKEND_PYTHON_PATH=["']?([^"'\n]+)["']?/);
      if (m?.[1]?.trim()) {
        const p = m[1].trim().replace(/^~/, os.homedir());
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return getPythonPath();
}

async function startBackend() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${BACKEND_URL}/api/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) { console.log('[Main] Backend already running'); return true; }
  } catch {}

  const python = getBackendPythonPath();
  if (!python) {
    console.error('[Main] No Python found for backend');
    return false;
  }

  const backendEnv = {
    ...process.env,
    TEZCAT_PORT: BACKEND_PORT,
    FRONTEND_PORT: IS_DEV ? '7341' : '6341',
    FLASK_DEBUG: IS_DEV ? '1' : '0',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    HOME: os.homedir(),
    NPCSH_BASE: path.join(os.homedir(), '.npcsh'),
  };

  const scriptPath = path.join(__dirname, '..', 'resources', 'tezcat_serve.py');
  backendProcess = spawnBackendProcess(python, [scriptPath], backendEnv);
  return await waitForServer();
}

app.on('before-quit', () => killBackendProcess());

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  if (IS_DEV) {
    win.loadURL('http://localhost:7341');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(async () => {
  await startBackend();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('readDirectory', async (_, dirPath: string) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries.map(e => ({
      name: e.name,
      path: path.join(dirPath, e.name),
      isDirectory: e.isDirectory(),
      size: e.isFile() ? (fs.statSync(path.join(dirPath, e.name)).size) : 0,
      modified: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).mtime.toISOString() : '',
    }));
  } catch (e) {
    return { error: (e as Error).message };
  }
});

ipcMain.handle('ensureDirectory', async (_, dirPath: string) => {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    return { success: true };
  } catch (e) {
    return { error: (e as Error).message };
  }
});

ipcMain.handle('getHomeDir', async () => os.homedir());

ipcMain.handle('show-open-dialog', async (_, options) => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return { canceled: true };
  const result = await dialog.showOpenDialog(win, options);
  return result;
});

ipcMain.handle('show-save-dialog', async (_, options) => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return { canceled: true };
  const result = await dialog.showSaveDialog(win, options);
  return result;
});

ipcMain.handle('read-file-content', async (_, filePath: string) => {
  try {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { content };
  } catch (e) {
    return { error: (e as Error).message };
  }
});

ipcMain.handle('write-file-content', async (_, filePath: string, content: string) => {
  try {
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { success: true };
  } catch (e) {
    return { error: (e as Error).message };
  }
});

ipcMain.handle('proxy-fetch', async (_event, url, options = {}) => {
  try {
    const resp = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || undefined,
    });
    const contentType = resp.headers.get('content-type') || '';
    let data;
    if (contentType.includes('json')) {
      data = await resp.json();
    } else {
      data = await resp.text();
    }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
});
