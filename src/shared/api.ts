/**
 * The contract between the window (renderer) and the main process.
 *
 * Types only: the preload script exposes an object of type `PaperRouteApi` as
 * `window.paperRoute`, and the main process implements it over IPC. Errors
 * don't survive Electron's IPC intact (only the message does), so every call
 * returns a `Result` with the error's code and details spelled out.
 */

import type { ErrorCode, ErrorDetails, SaveResult, VaultSummary } from "./types.js";

export type { ErrorCode, SaveResult, VaultSummary };

export interface ApiError {
  code: ErrorCode;
  message: string;
  details: ErrorDetails;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface AppState {
  /** 1Password account name, once the user has entered it. */
  accountName: string | null;
  /** The vault used last time, so it can be preselected. */
  lastVaultId: string | null;
  /** Move the original file to the Trash once it's safely in 1Password. Off by default. */
  trashAfterSave: boolean;
}

/**
 * What happened to the original file after a successful save:
 * - "kept": the Trash option is off.
 * - "trashed": moved to the Trash (recoverable from there).
 * - "changed": left in place because it changed on disk after it was read,
 *   so what's in 1Password isn't the current file.
 * - "failed": moving it to the Trash didn't work; it's still in place.
 */
export type OriginalFile = "kept" | "trashed" | "changed" | "failed";

export interface SaveOutcome extends SaveResult {
  original: OriginalFile;
}

export interface SaveArgs {
  /** Absolute path of the file to save. */
  filePath: string;
  vaultId: string;
  /** Item title; defaults to the file name when empty. */
  title?: string;
  allowDuplicate?: boolean;
}

/** A file handed to PaperRoute from outside the window (Finder, the menu-bar icon, another launch). */
export interface IncomingFile {
  path: string;
  /** How many more files came with it; only one is saved at a time. */
  othersIgnored: number;
}

export interface PaperRouteApi {
  getState(): Promise<AppState>;
  setAccount(accountName: string): Promise<Result<AppState>>;
  listVaults(): Promise<Result<VaultSummary[]>>;
  save(args: SaveArgs): Promise<Result<SaveOutcome>>;
  setTrashAfterSave(on: boolean): Promise<Result<AppState>>;
  /** Opens the native file picker; resolves to a path, or null if cancelled. */
  chooseFile(): Promise<string | null>;
  /** The filesystem path of a file dropped onto the window. */
  pathForFile(file: File): string;
  /** Hide the window (Escape). */
  hide(): Promise<void>;
  /** Called whenever the window is shown, so the UI can refocus and reset. */
  onShown(listener: () => void): void;
  /**
   * Call once the page is ready. Resolves to a file handed over before then
   * (if any); later ones arrive through onIncomingFile.
   */
  takeIncomingFile(): Promise<IncomingFile | null>;
  onIncomingFile(listener: (file: IncomingFile) => void): void;
}

/** IPC channel names, shared so main and preload can't drift apart. */
export const CHANNELS = {
  getState: "paper-route:get-state",
  setAccount: "paper-route:set-account",
  listVaults: "paper-route:list-vaults",
  save: "paper-route:save",
  chooseFile: "paper-route:choose-file",
  hide: "paper-route:hide",
  shown: "paper-route:shown",
  takeIncomingFile: "paper-route:take-incoming-file",
  incomingFile: "paper-route:incoming-file",
  setTrashAfterSave: "paper-route:set-trash-after-save",
} as const;
