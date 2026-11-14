/**
 * The only bridge between the sandboxed window and the main process. It
 * exposes `window.paperRoute` and nothing else; the window gets no Node, no
 * ipcRenderer, and no way to name arbitrary channels.
 *
 * Sandboxed preloads must be CommonJS and can't load our other modules, so the
 * channel names are repeated here; a test checks they match CHANNELS.
 */

import electron = require("electron");
import type { PaperRouteApi } from "../shared/api.js" with { "resolution-mode": "import" };

const { contextBridge, ipcRenderer, webUtils } = electron;

const CH = {
  getState: "paper-route:get-state",
  setAccount: "paper-route:set-account",
  listVaults: "paper-route:list-vaults",
  save: "paper-route:save",
  chooseFile: "paper-route:choose-file",
  hide: "paper-route:hide",
  shown: "paper-route:shown",
  takeIncomingFile: "paper-route:take-incoming-file",
  incomingFile: "paper-route:incoming-file",
};

const api: PaperRouteApi = {
  getState: () => ipcRenderer.invoke(CH.getState),
  setAccount: (accountName) => ipcRenderer.invoke(CH.setAccount, accountName),
  listVaults: () => ipcRenderer.invoke(CH.listVaults),
  save: (args) => ipcRenderer.invoke(CH.save, args),
  chooseFile: () => ipcRenderer.invoke(CH.chooseFile),
  pathForFile: (file) => webUtils.getPathForFile(file),
  hide: () => ipcRenderer.invoke(CH.hide),
  onShown: (listener) => {
    // Don't hand the IPC event object to the page.
    ipcRenderer.on(CH.shown, () => listener());
  },
  takeIncomingFile: () => ipcRenderer.invoke(CH.takeIncomingFile),
  onIncomingFile: (listener) => {
    // Pass on only the data, never the IPC event object.
    ipcRenderer.on(CH.incomingFile, (_event, file: Parameters<typeof listener>[0]) =>
      listener({ path: String(file.path), othersIgnored: Number(file.othersIgnored) || 0 }),
    );
  },
};

contextBridge.exposeInMainWorld("paperRoute", api);
