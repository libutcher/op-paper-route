/**
 * Plain data types shared by the core (Node), the main process, and the window
 * (browser). No imports, no runtime code: the window's build must not pull in
 * Node-only modules just to share a type.
 */

export type ErrorCode =
  /** The 1Password desktop app (or its SDK library) is not installed where the SDK looks. */
  | "APP_NOT_FOUND"
  /** No signed-in account in the app matches the configured account name. */
  | "ACCOUNT_NOT_FOUND"
  /** The user declined the approval prompt, or cancelled unlocking a locked app. */
  | "NOT_AUTHORIZED"
  /** The 10-minute inactivity window passed or the app locked mid-session; approving again fixes it. */
  | "SESSION_EXPIRED"
  | "RATE_LIMITED"
  | "FILE_UNREADABLE"
  | "FILE_TOO_LARGE"
  | "VAULT_NOT_FOUND"
  /** More than one vault has that title; the caller must pick by id. */
  | "VAULT_AMBIGUOUS"
  | "DUPLICATE_TITLE"
  /** The item was created but reading it back failed or returned different bytes. */
  | "VERIFY_FAILED"
  /** A request from the window was missing or malformed; retrying it unchanged cannot help. */
  | "INVALID_REQUEST"
  | "UNKNOWN";

export type ErrorDetails = Readonly<Record<string, string | number | boolean>>;

export interface VaultSummary {
  id: string;
  title: string;
}

export interface SaveResult {
  itemId: string;
  vaultId: string;
  title: string;
  fileName: string;
  bytes: number;
}
