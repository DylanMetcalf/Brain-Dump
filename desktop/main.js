// Brain Dump desktop shell.
//  • Lives in the menu bar / system tray — no big dashboard.
//  • Global shortcut (Cmd/Ctrl+Shift+Space) opens a tiny floating window and starts listening.
//  • The window is the same web client in "mini" mode, so phone and desktop share one brain.
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, session, shell } = require('electron');
const path = require('path');

const SERVER = process.env.BRAIN_DUMP_SERVER || 'http://localhost:8787';
const SHORTCUT = process.env.BRAIN_DUMP_SHORTCUT || 'CommandOrControl+Shift+Space';
let tray;
let mini;
let full;

function createMini() {
  mini = new BrowserWindow({
    width: 380, height: 520, show: false, frame: false, resizable: true, alwaysOnTop: true,
    skipTaskbar: true, fullscreenable: false, transparent: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  mini.loadURL(`${SERVER}/?mini=1`);
  mini.on('blur', () => { if (!mini.webContents.isDevToolsOpened()) mini.hide(); });
  mini.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function toggleMini(talk) {
  if (!mini) createMini();
  if (mini.isVisible() && !talk) return mini.hide();
  if (talk) mini.loadURL(`${SERVER}/?mini=1&talk=1`);
  mini.show();
  mini.focus();
}

function openFull() {
  if (full && !full.isDestroyed()) return full.show();
  full = new BrowserWindow({ width: 480, height: 820, webPreferences: { contextIsolation: true, sandbox: true } });
  full.loadURL(SERVER);
  full.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

app.whenReady().then(() => {
  // Microphone only for our own origin, and only because the user pressed the shortcut or tapped the orb.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' && wc.getURL().startsWith(SERVER));
  });
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 18, height: 18 }));
  tray.setToolTip('Brain Dump');
  if (icon.isEmpty()) tray.setTitle?.('●');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Talk', accelerator: SHORTCUT, click: () => toggleMini(true) },
    { label: 'Open Brain Dump', click: openFull },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]));
  tray.on('click', () => toggleMini(false));
  globalShortcut.register(SHORTCUT, () => toggleMini(true));
  if (process.platform === 'darwin') app.dock?.hide();
  createMini();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault()); // keep running in the tray
