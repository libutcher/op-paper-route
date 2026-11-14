/**
 * One error type for everything the core can fail with. The UI switches on
 * `code`; the original SDK or filesystem error is kept in `cause`.
 */

import sdk from "@1password/sdk";

export type ErrorCode =
  /** The 1Password desktop app (or its SDK library) is not installed where the SDK looks. */
  | "APP_NOT_FOUND"
  /** No signed-in account in the app matches the configured account name. */
  | "ACCOUNT_NOT_FOUND"
  /** The user declined the approval prompt, or the app is locked. */
  | "NOT_AUTHORIZED"
  /** The 10-minute inactivity window passed or the app was locked; approving again fixes it. */
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
  | "UNKNOWN";

export type ErrorDetails = Readonly<Record<string, string | number | boolean>>;

export class PaperRouteError extends Error {
  override readonly name = "PaperRouteError";
  readonly code: ErrorCode;
  /** Structured context for the UI, e.g. { itemId, encoded, limit }. */
  readonly details: ErrorDetails;

  constructor(code: ErrorCode, message: string, options: { cause?: unknown; details?: ErrorDetails } = {}) {
    super(message, { cause: options.cause });
    this.code = code;
    this.details = options.details ?? {};
  }
}

/** Short, user-facing messages for the codes that come from the SDK. */
const MESSAGES: Record<Exclude<ErrorCode, "UNKNOWN">, string> = {
  APP_NOT_FOUND: "1Password isn't installed, or its SDK integration can't be found",
  ACCOUNT_NOT_FOUND: "No signed-in 1Password account matches the configured account name",
  NOT_AUTHORIZED: "1Password didn't approve the request; unlock it and approve the prompt",
  SESSION_EXPIRED: "The 1Password session expired; approve again to continue",
  RATE_LIMITED: "1Password rate limit reached; try again in a moment",
  FILE_UNREADABLE: "The file couldn't be read",
  FILE_TOO_LARGE: "The file is too large to save through the 1Password SDK",
  VAULT_NOT_FOUND: "That vault wasn't found in the account",
  VAULT_AMBIGUOUS: "More than one vault has that name; choose it by id",
  DUPLICATE_TITLE: "A document with that title already exists in the vault",
  VERIFY_FAILED: "The document was created but couldn't be verified",
};

/**
 * Plain-Error messages the SDK produces, matched by substring.
 *
 * Confirmed against @1password/sdk 0.5.0:
 *  - "1Password desktop application not found" / "Native library is not available."
 *    (shared_lib_core.js, when the app or its dylib is missing)
 *  - "...Error { msg: Account not found, inner: None }" (observed in M0)
 *
 * UNCONFIRMED: the wording for a declined prompt and for a locked app. The
 * NOT_AUTHORIZED pattern is a guess until the M1 live probe records the real
 * strings; anything it misses falls through to UNKNOWN rather than being
 * mislabelled.
 */
const MESSAGE_PATTERNS: ReadonlyArray<readonly [RegExp, ErrorCode]> = [
  [/desktop application not found|Native library is not available/i, "APP_NOT_FOUND"],
  [/Account not found/i, "ACCOUNT_NOT_FOUND"],
  [/\b(denied|rejected|not authori[sz]ed|unauthori[sz]ed|locked)\b/i, "NOT_AUTHORIZED"],
];

/** Wrap anything thrown by the SDK (or already a PaperRouteError) into a PaperRouteError. */
export function fromSdkError(err: unknown): PaperRouteError {
  if (err instanceof PaperRouteError) return err;

  if (err instanceof sdk.DesktopSessionExpiredError || err instanceof sdk.AuthExpiredError) {
    return new PaperRouteError("SESSION_EXPIRED", MESSAGES.SESSION_EXPIRED, { cause: err });
  }
  if (err instanceof sdk.RateLimitExceededError) {
    return new PaperRouteError("RATE_LIMITED", MESSAGES.RATE_LIMITED, { cause: err });
  }

  const message = err instanceof Error ? err.message : String(err);
  for (const [pattern, code] of MESSAGE_PATTERNS) {
    if (code !== "UNKNOWN" && pattern.test(message)) {
      return new PaperRouteError(code, MESSAGES[code], { cause: err });
    }
  }
  return new PaperRouteError("UNKNOWN", `1Password error: ${message}`, { cause: err });
}

export function messageFor(code: Exclude<ErrorCode, "UNKNOWN">): string {
  return MESSAGES[code];
}
