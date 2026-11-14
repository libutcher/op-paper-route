/**
 * Electron main process: a menu-bar utility with one small window.
 *
 * The 1Password SDK runs here, in the one long-lived process, because desktop
 * authorization is granted per process. The window is a sandboxed page with
 * no Node access; it reaches this process only through the IPC handlers below.
 */

import { BrowserWindow, Menu, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, session, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS } from "../shared/api.js";
import { Inbox, firstFile, pathArguments } from "./handoff.js";
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

// Files handed to the app from outside the window wait here until the window
// is ready for them.
const inbox = new Inbox((file) => win?.webContents.send(CHANNELS.incomingFile, file));

/**
 * Take the first real file among `candidates`, show the window, and hand the
 * file to it. Returns false (and shows nothing) if there was no usable file.
 */
async function receive(candidates: readonly string[], cwd: string): Promise<boolean> {
  const file = await firstFile(candidates, cwd);
  if (!file) return false;
  // Show first: the window resets its status line when shown, and messages to
  // it arrive in order, so the file (and any note about it) must come after.
  showWindow();
  inbox.deliver(file);
  return true;
}

const isDefaultApp = process.defaultApp === true;

// macOS "open with" (a file dropped on the app icon, or opened with it from
// Finder) only fires for a packaged app; wired now so M4 needs no app changes.
// It can arrive before the app is ready, so it's registered first.
app.on("open-file", (event, path) => {
  event.preventDefault();
  void receive([path], "/");
});

// Two copies would each need their own 1Password approval. Hand off to the
// running one instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch, e.g. from the Finder Quick Action, carries its file
  // paths on the command line.
  app.on("second-instance", (_event, argv, workingDirectory) => {
    // receive() shows the window when there's a file; show it here only when
    // there isn't, so the window is shown (and told so) once, not twice.
    void receive(pathArguments(argv, { isDefaultApp }), workingDirectory).then((found) => {
      if (!found) showWindow();
    });
  });
  app.whenReady().then(start).catch((err: unknown) => {
    dialog.showErrorBox("PaperRoute couldn't start", String(err));
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
    integrationName: "PaperRoute",
    integrationVersion: version,
    // The Trash, not deletion: the user can always get the file back.
    trash: (path) => shell.trashItem(path),
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
  handle(CHANNELS.setTrashAfterSave, (on: unknown) => handlers.setTrashAfterSave(on));
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
  handle(CHANNELS.takeIncomingFile, async () => inbox.take());

  createWindow();
  createTray();

  // A first launch can carry a file too (the Quick Action starting the app).
  void receive(pathArguments(process.argv, { isDefaultApp }), process.cwd());

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
    height: 450,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: "PaperRoute",
    // Matches the page's own background (styles.css --bg), so there's no
    // white flash before it draws.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e20" : "#f6f6f4",
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
  // While the page (re)loads it can't receive files; hold them until it asks.
  win.webContents.on("did-start-loading", () => inbox.reset());

  // Problems inside the window are otherwise invisible: a script error just
  // leaves a blank window. Send them to the app's log.
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") {
      console.warn(`[paper-route] window ${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  win.webContents.on("did-fail-load", (_event, code, description, url) => {
    console.error(`[paper-route] window failed to load ${url}: ${description} (${code})`);
    // The page may never draw now; don't let that make the window unshowable.
    markWindowReady();
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[paper-route] window process ended: ${details.reason} (exit code ${details.exitCode})`);
    markWindowReady();
  });

  // Closing hides; the app lives in the menu bar until Quit.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win?.hide();
    }
  });

  win.once("ready-to-show", markWindowReady);
  // Waiting for the first paint only avoids a flash. If it hasn't come after a
  // few seconds, something is wrong, and the window must still be reachable
  // from the hotkey and the menu rather than stuck hidden until a restart.
  setTimeout(markWindowReady, READY_TIMEOUT_MS);

  void win.loadFile(INDEX_HTML);
}

function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("📄");
  tray.setToolTip(`PaperRoute — press ${HOTKEY_WORDS}, or drop a file here`);
  tray.on("drop-files", (_event, files) => void receive(files, "/"));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      // Show the shortcut in the menu, but don't register it a second time:
      // the global shortcut already owns it.
      { label: "Save a Document…", accelerator: HOTKEY, registerAccelerator: false, click: showWindow },
      { type: "separator" },
      { label: "Quit PaperRoute", role: "quit" },
    ]),
  );
}

/** False until the page has drawn for the first time (or given up trying). */
let windowReady = false;
/** Something asked to show the window before it was ready. */
let showWhenReady = false;
const READY_TIMEOUT_MS = 5000;

/** From now on the window can be shown; show it if that was asked for. Safe to call more than once. */
function markWindowReady(): void {
  if (windowReady) return;
  windowReady = true;
  if (showWhenReady) showWindow();
}

function showWindow(): void {
  if (!win) return;
  if (!windowReady) {
    // Showing now would flash an empty window; show once the page has drawn.
    showWhenReady = true;
    return;
  }
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
