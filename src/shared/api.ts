/**
 * The contract between the window (renderer) and the main process.
 *
 * Types only: the preload script exposes an object of type `PaperRouteApi` as
 * `window.paperRoute`, and the main process implements it over IPC. Errors
 * don't survive Electron's IPC intact (only the message does), so every call
 * returns a `Result` with the error's code and details spelled out.
 */

import type { ErrorCode, ErrorDetails } from "../core/errors.js";
import type { SaveResult } from "../core/save.js";
import type { VaultSummary } from "../core/vaults.js";

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
}

export interface SaveArgs {
  /** Absolute path of the file to save. */
  filePath: string;
  vaultId: string;
  /** Item title; defaults to the file name when empty. */
  title?: string;
  allowDuplicate?: boolean;
}

export interface PaperRouteApi {
  getState(): Promise<AppState>;
  setAccount(accountName: string): Promise<Result<AppState>>;
  listVaults(): Promise<Result<VaultSummary[]>>;
  save(args: SaveArgs): Promise<Result<SaveResult>>;
  /** Opens the native file picker; resolves to a path, or null if cancelled. */
  chooseFile(): Promise<string | null>;
  /** The filesystem path of a file dropped onto the window. */
  pathForFile(file: File): string;
  /** Hide the window (Escape). */
  hide(): Promise<void>;
  /** Called whenever the window is shown, so the UI can refocus and reset. */
  onShown(listener: () => void): void;
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
} as const;
