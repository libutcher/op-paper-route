/**
 * What the main process does for each call from the window, kept free of
 * Electron imports so it can be tested with a fake 1Password client.
 */

import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { PaperRouteError, Session, listVaults, saveDocument, type Connect } from "../core/index.js";
import type { ApiError, AppState, OriginalFile, Result, SaveArgs, SaveOutcome, VaultSummary } from "../shared/api.js";
import { accountNameCandidates, tidySpaces } from "./account-names.js";
import type { SettingsStore } from "./settings.js";

export interface HandlerOptions {
  settings: SettingsStore;
  integrationName: string;
  integrationVersion: string;
  /** Replaces the SDK connection; tests inject a fake here. */
  connect?: Connect;
  /** Moves a file to the Trash (Electron's shell.trashItem in the app). */
  trash: (path: string) => Promise<void>;
}

export interface Handlers {
  getState(): Promise<AppState>;
  setAccount(accountName: unknown): Promise<Result<AppState>>;
  setTrashAfterSave(on: unknown): Promise<Result<AppState>>;
  listVaults(): Promise<Result<VaultSummary[]>>;
  save(args: unknown): Promise<Result<SaveOutcome>>;
}

/** Enough of a file's identity to tell whether it changed: size and modification time. */
async function fingerprint(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return `${info.size}:${info.mtimeMs}`;
  } catch {
    return null;
  }
}

function toApiError(err: unknown): ApiError {
  if (err instanceof PaperRouteError) return { code: err.code, message: err.message, details: err.details };
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err), details: {} };
}

function invalid(message: string): { ok: false; error: ApiError } {
  return { ok: false, error: { code: "INVALID_REQUEST", message, details: {} } };
}

async function attempt<T>(work: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    return { ok: false, error: toApiError(err) };
  }
}

export function createHandlers(options: HandlerOptions): Handlers {
  const { settings } = options;
  // One Session for the life of the process (authorization is per process),
  // replaced only when the account changes.
  let session: Session | null = null;
  let sessionAccount: string | null = null;

  const sessionFor = (accountName: string): Session => {
    if (!session || sessionAccount !== accountName) {
      session = new Session({
        accountName,
        integrationName: options.integrationName,
        integrationVersion: options.integrationVersion,
        ...(options.connect ? { connect: options.connect } : {}),
      });
      sessionAccount = accountName;
    }
    return session;
  };

  const requireSession = async (): Promise<Session> => {
    const { accountName } = await settings.get();
    if (!accountName) {
      throw new PaperRouteError("ACCOUNT_NOT_FOUND", "Enter your 1Password account name first");
    }
    return sessionFor(accountName);
  };

  return {
    async getState() {
      return settings.get();
    },

    async setAccount(accountName) {
      // Everything from the window is untrusted input at this boundary.
      if (typeof accountName !== "string") return invalid("Account name can't be empty");
      const candidates = accountNameCandidates(accountName);
      if (candidates.length === 0) return invalid("Account name can't be empty");

      // Check the name works before saving it, so a typo is caught here rather
      // than after the user has moved on. Connecting is the only way to check:
      // a name 1Password doesn't know fails at once, with no prompt, so the
      // near-identical spellings cost nothing. The session that connects is
      // kept, so the user approves once, not again when vaults load.
      return attempt(async () => {
        for (const candidate of candidates) {
          try {
            await listVaults(sessionFor(candidate));
          } catch (err) {
            if (err instanceof PaperRouteError && err.code === "ACCOUNT_NOT_FOUND") continue;
            throw err; // Declined, 1Password not running, …: stop and say so.
          }
          return settings.update({ accountName: candidate });
        }
        const typed = tidySpaces(accountName);
        throw new PaperRouteError(
          "ACCOUNT_NOT_FOUND",
          `No 1Password account called “${typed}” is signed in. The name must match exactly, including capital letters.`,
          { details: { typed } },
        );
      });
    },

    async setTrashAfterSave(on) {
      if (typeof on !== "boolean") return invalid("The Trash option must be on or off");
      return attempt(() => settings.update({ trashAfterSave: on }));
    },


    async listVaults() {
      return attempt(async () => listVaults(await requireSession()));
    },

    async save(args) {
      if (typeof args !== "object" || args === null) return invalid("Missing save arguments");
      const { filePath, vaultId, title, allowDuplicate } = args as Partial<Record<keyof SaveArgs, unknown>>;
      if (typeof filePath !== "string" || !isAbsolute(filePath)) return invalid("A file path is required");
      if (typeof vaultId !== "string" || !vaultId) return invalid("Choose a vault first");
      if (title !== undefined && typeof title !== "string") return invalid("Title must be text");

      return attempt(async () => {
        // Taken before the save, to check afterwards that the file on disk is
        // still the one that was saved before moving it to the Trash. Taken
        // whatever the Trash setting is now, because the setting that counts
        // is the one in effect when the save finishes (see below).
        const before = await fingerprint(filePath);

        const result = await saveDocument(await requireSession(), {
          filePath,
          vaultId,
          ...(typeof title === "string" && title.trim() ? { title } : {}),
          tags: ["paper-route"],
          onDuplicate: allowDuplicate === true ? "allow" : "fail",
        });
        // The document is in 1Password now. Failing to remember the vault is
        // minor and must not be reported as a failed save: the user would
        // retry, and the retry would make a second copy.
        await settings.update({ lastVaultId: vaultId }).catch((err: unknown) => {
          console.warn(`[paper-route] saved, but couldn't remember the vault: ${String(err)}`);
        });

        // saveDocument only returns once the bytes have been read back from
        // 1Password and matched, so the document is safely stored here.
        // Read the Trash option now, not when the save started: a save can
        // wait minutes for 1Password's approval, and if the box was unticked
        // meanwhile, that is what the user wants for this file.
        const { trashAfterSave } = await settings.get();
        let original: OriginalFile = "kept";
        if (trashAfterSave) {
          const after = await fingerprint(filePath);
          if (before === null || after !== before || !after.startsWith(`${result.bytes}:`)) {
            // It changed while it was being saved: what's in 1Password isn't
            // the current file, so the current file must not be thrown away.
            original = "changed";
          } else {
            try {
              await options.trash(filePath);
              original = "trashed";
            } catch (err) {
              // Like the settings write: never report a stored document as a failure.
              console.warn(`[paper-route] saved, but couldn't move the original to the Trash: ${String(err)}`);
              original = "failed";
            }
          }
        }
        return { ...result, original };
      });
    },
  };
}
