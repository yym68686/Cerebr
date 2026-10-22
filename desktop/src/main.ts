import { app, BrowserWindow, ipcMain, protocol, net, Menu, shell, utilityProcess } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DesktopUpdater } from './updater';
import { scheduleUpdateChecks } from './update-scheduler.js';

if (squirrelStartup) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.Cerebr.Cerebr');

protocol.registerSchemesAsPrivileged([
    {
        scheme: 'cerebr',
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
]);
app.setName('Cerebr');
const profileArg = process.argv.find((arg) => arg.startsWith('--profile='));
if (profileArg) app.setPath('userData', path.resolve(profileArg.slice(10)));
if (!app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | null = null;
let worker: any;
let workerReady = false;
let cachedStatus: any = { connected: false, error: null };
let updater: DesktopUpdater;
const waiting = new Map<
    string,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: any }
>();
const messages: any[] = [];
const root = path.join(__dirname, 'renderer');
function safeSender(event: any) {
    if (
        event.sender !== window?.webContents ||
        event.senderFrame !== window?.webContents.mainFrame ||
        !event.senderFrame?.url.startsWith('cerebr://app/')
    )
        throw new Error('Untrusted desktop caller');
}
function request(kind: string, payload?: unknown) {
    return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID();
        const timer = setTimeout(
            () => {
                waiting.delete(requestId);
                reject(new Error('Desktop sync service did not respond'));
            },
            kind === 'browser-request' ? 50000 : 10000
        );
        waiting.set(requestId, { resolve, reject, timer });
        worker.postMessage({ kind, requestId, payload });
    });
}
function createWindow() {
    window = new BrowserWindow({
        width: 1100,
        height: 800,
        minWidth: 360,
        minHeight: 480,
        title: 'Cerebr',
        frame: false,
        ...(process.platform === 'darwin'
            ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 16 } }
            : {}),
        autoHideMenuBar: true,
        backgroundColor: '#1f1f22',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
        },
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith('cerebr://app/')) {
            event.preventDefault();
            if (/^https?:/.test(url)) void shell.openExternal(url);
        }
    });
    window.webContents.session.setPermissionRequestHandler((_wc, permission, callback) =>
        callback(permission === 'clipboard-sanitized-write')
    );
    window.once('ready-to-show', () => window?.show());
    window.on('closed', () => {
        worker?.postMessage({ kind: 'clear-desktop-progress' });
        window = null;
    });
    void window.loadURL('cerebr://app/index.html');
}
app.on('second-instance', () => {
    if (!window) createWindow();
    window?.show();
    window?.focus();
});
app.whenReady().then(() => {
    protocol.handle('cerebr', async (request) => {
        const url = new URL(request.url);
        if (url.host !== 'app') return new Response('Not found', { status: 404 });
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, ''),
            file = path.resolve(root, relative || 'index.html');
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file))
            return new Response('Not found', { status: 404 });
        const response = await net.fetch(pathToFileURL(file).href);
        if (file === path.join(root, 'index.html')) {
            const headers = new Headers(response.headers);
            headers.set(
                'Content-Security-Policy',
                "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self' https: http: ws: wss:; frame-src 'self' blob: https:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'"
            );
            return new Response(response.body, { status: response.status, headers });
        }
        return response;
    });
    fs.mkdirSync(app.getPath('userData'), { recursive: true, mode: 0o700 });
    fs.chmodSync(app.getPath('userData'), 0o700);
    worker = utilityProcess.fork(
        path.join(__dirname, 'sync-service.cjs'),
        [path.join(app.getPath('userData'), 'history-sync.sqlite')],
        { serviceName: 'Cerebr History Sync', stdio: 'pipe' }
    );
    const log = fs.createWriteStream(path.join(app.getPath('userData'), 'desktop-sync.log'), {
        flags: 'a',
        mode: 0o600,
    });
    worker.stderr?.on('data', (data: Buffer) => log.write(data));
    worker.on('message', (message: any) => {
        if (message.event === 'ready') {
            workerReady = true;
            for (const queued of messages.splice(0)) worker.postMessage(queued);
        }
        if (message.event === 'status') {
            cachedStatus = message.status;
            window?.webContents.send('desktop:status', cachedStatus);
        }
        if (message.event === 'error') {
            cachedStatus = { connected: false, error: message.error };
            window?.webContents.send('desktop:status', cachedStatus);
        }
        if (message.event === 'sync-message') window?.webContents.send('desktop:sync', message.message);
        if (message.event === 'browser-event')
            window?.webContents.send('desktop:browser-event', message.payload);
        if (message.requestId) {
            const pending = waiting.get(message.requestId);
            if (pending) {
                clearTimeout(pending.timer);
                waiting.delete(message.requestId);
                message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
            }
        }
    });
    worker.on('exit', () => {
        workerReady = false;
        cachedStatus = { connected: false, error: '同步服务已退出，请重新启动 Cerebr。' };
        window?.webContents.send('desktop:status', cachedStatus);
    });
    ipcMain.on('desktop:send', (event, message) => {
        safeSender(event);
        const payload = { kind: 'message', message };
        workerReady ? worker.postMessage(payload) : messages.push(payload);
    });
    ipcMain.handle('desktop:status', (event) => {
        safeSender(event);
        return workerReady ? request('status') : cachedStatus;
    });
    ipcMain.handle('desktop:pairing', (event) => {
        safeSender(event);
        return request('pairing');
    });
    ipcMain.handle('desktop:browser-request', (event, payload) => {
        safeSender(event);
        if (!workerReady) throw new Error('Browser extension disconnected');
        return request('browser-request', payload);
    });
    updater = new DesktopUpdater(
        (status) => window?.webContents.send('desktop:update-status', status),
        async () => {
            if (!workerReady) throw new Error('Sync service is unavailable');
            await request('status');
        }
    );
    ipcMain.handle('desktop:update-status', (event) => {
        safeSender(event);
        const id = process.argv.find((arg) => arg.startsWith('--cerebr-update-id='))?.split('=')[1];
        if (id && /^download-(?:[A-Za-z0-9]{6}|\d+\.\d+\.\d+-(?:darwin|win32)-(?:arm64|x64))$/.test(id)) {
            const directory = path.join(app.getPath('userData'), 'updates', id);
            if (fs.existsSync(directory))
                fs.writeFileSync(path.join(directory, 'restarted'), app.getVersion(), { mode: 0o600 });
        }
        return updater.status;
    });
    ipcMain.handle('desktop:update-check', (event) => {
        safeSender(event);
        void updater.check(true);
        return updater.status;
    });
    ipcMain.handle('desktop:update-ready', async (event) => {
        safeSender(event);
        await updater.install();
    });
    ipcMain.on('desktop:update-save-failed', (event) => {
        safeSender(event);
        updater.saveFailed();
    });
    ipcMain.on('desktop:window', (event, action) => {
        safeSender(event);
        if (action === 'minimize') window?.minimize();
        if (action === 'maximize') {
            if (window?.isMaximized()) window.unmaximize();
            else window?.maximize();
        }
        if (action === 'close') window?.close();
    });
    Menu.setApplicationMenu(
        Menu.buildFromTemplate([
            ...(process.platform === 'darwin'
                ? [
                      {
                          label: 'Cerebr',
                          submenu: [
                              { role: 'about' as const },
                              { type: 'separator' as const },
                              { role: 'hide' as const },
                              { role: 'quit' as const },
                          ],
                      },
                  ]
                : []),
            {
                label: '编辑',
                submenu: [
                    { role: 'undo' },
                    { role: 'redo' },
                    { type: 'separator' },
                    { role: 'cut' },
                    { role: 'copy' },
                    { role: 'paste' },
                    { label: '在聊天中查找', accelerator: 'CmdOrCtrl+F', click: () => window?.webContents.send('desktop:find') },
                    { label: '全选', accelerator: 'CmdOrCtrl+A', click: () => window?.webContents.send('desktop:select-all') },
                ],
            },
            {
                label: '视图',
                submenu: [
                    { role: 'reload' },
                    { role: 'toggleDevTools' },
                    { role: 'resetZoom' },
                    { role: 'zoomIn' },
                    { role: 'zoomOut' },
                    { role: 'togglefullscreen' },
                ],
            },
            { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
        ] as any)
    );
    createWindow();
    if (app.isPackaged) {
        const stopUpdates = scheduleUpdateChecks(updater, {online: () => net.isOnline()});
        app.once('before-quit', stopUpdates);
    }
    app.on('activate', () => {
        if (!window) createWindow();
    });
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', () => worker?.postMessage({ kind: 'close' }));
