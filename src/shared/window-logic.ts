/**
 * The window's decisions, separated from the DOM so they can be unit-tested.
 *
 * Runs in the sandboxed window (imported by src/renderer/renderer.ts), so it
 * must stay free of Node and DOM APIs: plain data in, plain data out.
 */

import type { ApiError, ErrorCode, IncomingFile, OriginalFile, Result, VaultSummary } from "./api.js";

/**
 * A file handed over from Finder or the menu-bar icon while a save is in
 * progress waits here, so nothing is swapped out from under a save. Only the
 * latest waiting file is kept.
 */
export class IncomingQueue {
  #next: IncomingFile | null = null;

  /** True if the file should be loaded now; false if it was queued because the window is busy. */
  offer(file: IncomingFile, busy: boolean): boolean {
    if (!busy) {
      // Anything older that was waiting is superseded by this newer file.
      this.#next = null;
      return true;
    }
    this.#next = file;
    return false;
  }

  /** The waiting file, if any, without removing it. */
  peek(): IncomingFile | null {
    return this.#next;
  }

  /** Remove and return the waiting file, if any. */
  take(): IncomingFile | null {
    const next = this.#next;
    this.#next = null;
    return next;
  }
}

/** The note shown when several files arrive and only the first is used. */
export function oneAtATimeNote(fileName: string, othersIgnored: number): string | null {
  if (othersIgnored <= 0) return null;
  const others = othersIgnored === 1 ? "1 other file" : `${othersIgnored} other files`;
  return `Saving one file at a time: using “${fileName}”, not ${others}.`;
}

/** 1Password ends an approval after ten minutes without use. */
export const APPROVAL_IDLE_MS = 10 * 60 * 1000;

/** Errors where the same request may succeed if sent again. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "NOT_AUTHORIZED",
  "SESSION_EXPIRED",
  "RATE_LIMITED",
  // Starting 1Password, or turning on its SDK setting, then retrying is the fix.
  "APP_NOT_FOUND",
  "UNKNOWN",
]);

/**
 * Whether to offer Try Again. Input problems (INVALID_REQUEST), a bad file, a
 * duplicate or a failed verification need something to change first.
 */
export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

/** Errors that mean the approval is missing or gone, so the next call will prompt. */
const APPROVAL_LOST: ReadonlySet<ErrorCode> = new Set([
  "NOT_AUTHORIZED",
  "SESSION_EXPIRED",
  "ACCOUNT_NOT_FOUND",
  "APP_NOT_FOUND",
]);

/** Errors raised before 1Password is contacted; they say nothing about approval. */
const LOCAL_ONLY: ReadonlySet<ErrorCode> = new Set(["INVALID_REQUEST", "FILE_UNREADABLE", "FILE_TOO_LARGE"]);

/**
 * Tracks whether the next call is likely to show 1Password's approval prompt,
 * so the window only tells the user to approve something when there probably
 * is something to approve.
 */
export class ApprovalTracker {
  /** When 1Password last answered, or null if it hasn't or its approval has ended. */
  #lastAnsweredAt: number | null = null;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Record how a call to the main process turned out. */
  note(result: Result<unknown>): void {
    if (result.ok) this.#lastAnsweredAt = this.#now();
    else if (APPROVAL_LOST.has(result.error.code)) this.#lastAnsweredAt = null;
    else if (!LOCAL_ONLY.has(result.error.code)) this.#lastAnsweredAt = this.#now();
  }

  /** Forget any approval, e.g. after switching accounts. */
  reset(): void {
    this.#lastAnsweredAt = null;
  }

  /** True when the next call will probably show the approval prompt. */
  promptLikely(): boolean {
    return this.#lastAnsweredAt === null || this.#now() - this.#lastAnsweredAt > APPROVAL_IDLE_MS;
  }
}

/** What to show when a call is taking a while. */
export function slowCallMessage(working: string, promptLikely: boolean): { text: string; tone: "waiting" | "working" } {
  return promptLikely
    ? { text: "Waiting for 1Password — approve the request in the 1Password app.", tone: "waiting" }
    : // 1Password can still prompt if it was locked meanwhile, so mention it softly.
      { text: `${working} Still working. If 1Password asks for approval, approve it there.`, tone: "working" };
}

/** The last path component, for display and as the default title. */
export function fileNameOf(path: string): string {
  return path.split("/").pop() || path;
}

/**
 * The title to pre-fill, and which part to select.
 *
 * The title is the whole file name, extension included: that is the title the
 * core and the CLI use by default, and the duplicate check compares titles
 * exactly, so the same file must get the same title however it is saved. Only
 * the name part is selected, so typing renames it and keeps the extension.
 */
export function titleFor(fileName: string): { value: string; selectStart: number; selectEnd: number } {
  const dot = fileName.lastIndexOf(".");
  // A leading dot (".env") is part of the name, not an extension.
  return { value: fileName, selectStart: 0, selectEnd: dot > 0 ? dot : fileName.length };
}

/** Labels for the vault menu. Titles repeat in real accounts, so those that do get part of their id. */
export function vaultOptions(vaults: readonly VaultSummary[]): Array<{ value: string; label: string }> {
  const counts = new Map<string, number>();
  for (const v of vaults) counts.set(v.title, (counts.get(v.title) ?? 0) + 1);
  return vaults.map((v) => ({
    value: v.id,
    label: (counts.get(v.title) ?? 0) > 1 ? `${v.title} (${v.id.slice(0, 6)})` : v.title,
  }));
}

/**
 * The message after a save when a waiting file comes up next. It keeps the
 * "one file at a time" note for that file, which would otherwise be lost: the
 * note is set when the file loads and this message replaces it immediately.
 */
export function savedThenNext(savedText: string, next: IncomingFile): string {
  const name = fileNameOf(next.path);
  const note = oneAtATimeNote(name, next.othersIgnored);
  return note ? `${savedText} Next: “${name}”. ${note}` : `${savedText} Next: “${name}”.`;
}

/** The success message, including what happened to the original when the Trash option is on. */
export function savedMessage(title: string, vaultName: string, original: OriginalFile): { text: string; tone: "ok" | "waiting" } {
  const saved = `Saved “${title}” to ${vaultName}.`;
  switch (original) {
    case "kept":
      return { text: saved, tone: "ok" };
    case "trashed":
      return { text: `${saved} The original is in the Trash.`, tone: "ok" };
    case "changed":
      return { text: `${saved} The original changed while saving, so it was left in place.`, tone: "waiting" };
    case "failed":
      return { text: `${saved} Couldn't move the original to the Trash; it's still in place.`, tone: "waiting" };
  }
}

/** A short, plain-language message for an error. */
export function describeError(error: ApiError): string {
  const d = error.details;
  const mb = (n: unknown) => `${(Number(n) / 1024 / 1024).toFixed(1)} MB`;
  switch (error.code) {
    case "NOT_AUTHORIZED":
      return "1Password didn't approve the request.";
    case "SESSION_EXPIRED":
      return "The 1Password session ended. Try again to approve a new one.";
    case "APP_NOT_FOUND":
      return "1Password isn't running, or “Integrate with 1Password SDKs” is off in Settings → Developer.";
    case "FILE_TOO_LARGE":
      return "encoded" in d
        ? `Too large: this file needs ${mb(d.encoded)} and the limit is ${mb(d.limit)}.`
        : `Too large: ${mb(d.bytes)}, and nothing over ${mb(d.maxFileBytes)} can fit.`;
    case "DUPLICATE_TITLE":
      return `A document called “${String(d.title)}” is already in this vault.`;
    default:
      return error.message;
  }
}
