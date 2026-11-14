// A stand-in for the real preload (src/app/preload.cts) used only to record
// the demo. It gives the window the same `window.paperRoute` API, backed by
// invented data and fixed delays instead of 1Password, so the recording is
// repeatable and shows nothing personal. The recorder (record.cjs) triggers
// the Quick Action handoff over IPC.
const { contextBridge, ipcRenderer } = require("electron");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const VAULTS = [
  { id: "v-family", title: "Family Documents" },
  { id: "v-personal", title: "Personal" },
  { id: "v-receipts", title: "Receipts" },
  { id: "v-tax", title: "Tax 2026" },
];

const state = { accountName: "Example Family", lastVaultId: "v-receipts", trashAfterSave: false };
let onIncoming = null;

const api = {
  getState: async () => ({ ...state }),
  setAccount: async (accountName) => {
    state.accountName = accountName;
    return { ok: true, value: { ...state } };
  },
  // Slow enough that the window shows "Waiting for 1Password" before the vaults arrive.
  listVaults: async () => {
    await wait(3200);
    return { ok: true, value: VAULTS };
  },
  save: async (args) => {
    await wait(1400);
    state.lastVaultId = args.vaultId;
    const title = args.title?.trim() || "Dentist receipt.pdf";
    return {
      ok: true,
      value: {
        itemId: "demo-item",
        vaultId: args.vaultId,
        title,
        fileName: "Dentist receipt.pdf",
        bytes: 184_320,
        original: state.trashAfterSave ? "trashed" : "kept",
      },
    };
  },
  setTrashAfterSave: async (on) => {
    state.trashAfterSave = on;
    return { ok: true, value: { ...state } };
  },
  chooseFile: async () => null,
  pathForFile: () => "",
  hide: async () => {},
  onShown: () => {},
  takeIncomingFile: async () => null,
  onIncomingFile: (listener) => {
    onIncoming = listener;
  },
};

ipcRenderer.on("demo:incoming", (_event, file) => onIncoming?.(file));
contextBridge.exposeInMainWorld("paperRoute", api);
