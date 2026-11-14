/**
 * Electron main process: a menu-bar utility with one small window.
 *
 * The 1Password SDK runs here, in the one long-lived process, because desktop
 * authorization is granted per process. The window is a sandboxed page with
 * no Node access; it reaches this process only through the IPC handlers below.
 */

import { BrowserWindow, Menu, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, session } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "../shared/api.js";
import { createHandlers } from "./handlers.js";
import { isOurPage } from "./sender.js";
import { SettingsStore } from "./settings.js";

const here = dirname(fileURLToPath(import.meta.url));
const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
const INDEX_HTML = join(here, "../renderer/index.html");
const HOTKEY = "Control+Alt+P";
// Spelled out: the ⌃ symbol is easy to mistake for an arrow key.
const HOTKEY_WORDS = "Control-Option-P";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// Two copies would each need their own 1Password approval. Hand off to the
// running one instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(start).catch((err: unknown) => {
    dialog.showErrorBox("Paper Route couldn't start", String(err));
    app.exit(1);
  });
}

async function start(): Promise<void> {
  // A menu-bar app: no Dock icon.
  app.dock?.hide();

  // The window never needs camera, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  const handlers = createHandlers({
    settings: new SettingsStore(join(app.getPath("userData"), "settings.json")),
    integrationName: "Paper Route",
    integrationVersion: version,
  });

  // Only our own page may call these. Arguments are validated in handlers.
  const fromOurWindow = (event: IpcMainInvokeEvent) => isOurPage(event.senderFrame?.url, INDEX_HTML);
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>) =>
    ipcMain.handle(channel, (event, ...args) => {
      if (!fromOurWindow(event)) throw new Error("Rejected IPC from an unexpected sender");
      return fn(...(args as A));
    });

  handle(CHANNELS.getState, () => handlers.getState());
  handle(CHANNELS.setAccount, (name: unknown) => handlers.setAccount(name));
  handle(CHANNELS.listVaults, () => handlers.listVaults());
  handle(CHANNELS.save, (args: unknown) => handlers.save(args));
  handle(CHANNELS.chooseFile, async () => {
    const options = { title: "Choose a document to save to 1Password", properties: ["openFile" as const] };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle(CHANNELS.hide, async () => {
    win?.hide();
  });

  createWindow();
  createTray();

  console.log(
    globalShortcut.register(HOTKEY, toggleWindow)
      ? `[paper-route] ${HOTKEY_WORDS} opens the window`
      : `[paper-route] couldn't register ${HOTKEY_WORDS}; another app may be using it. The menu-bar icon still works.`,
  );

  showWindow();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 440,
    height: 420,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: "Paper Route",
    webPreferences: {
      preload: join(here, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  // Dropping a file anywhere but the drop zone would otherwise navigate the
  // window to that file. Nothing in this app ever navigates or opens windows.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Closing hides; the app lives in the menu bar until Quit.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  void win.loadFile(INDEX_HTML);
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("📄");
  tray.setToolTip(`Paper Route — press ${HOTKEY_WORDS} to open`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // Show the shortcut in the menu, but don't register it a second time:
      // the global shortcut already owns it.
      { label: "Save a Document…", accelerator: HOTKEY, registerAccelerator: false, click: showWindow },
      { type: "separator" },
      { label: "Quit Paper Route", role: "quit" },
    ]),
  );
}

function showWindow(): void {
  if (!win) return;
  if (!win.isVisible()) win.center();
  win.show();
  win.focus();
  app.focus({ steal: true });
  win.webContents.send(CHANNELS.shown);
}

function toggleWindow(): void {
  if (win?.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

app.on("before-quit", () => {
  quitting = true;
});
app.on("will-quit", () => globalShortcut.unregisterAll());
// Stay running with no windows open: this is a menu-bar app.
app.on("window-all-closed", () => {});
