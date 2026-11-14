/**
 * What the main process does for each call from the window, kept free of
 * Electron imports so it can be tested with a fake 1Password client.
 */

import { isAbsolute } from "node:path";
import { PaperRouteError, Session, listVaults, saveDocument, type Connect } from "../core/index.js";
import type { ApiError, AppState, Result, SaveArgs, SaveResult, VaultSummary } from "../shared/api.js";
import type { SettingsStore } from "./settings.js";

export interface HandlerOptions {
  settings: SettingsStore;
  integrationName: string;
  integrationVersion: string;
  /** Replaces the SDK connection; tests inject a fake here. */
  connect?: Connect;
}

export interface Handlers {
  getState(): Promise<AppState>;
  setAccount(accountName: unknown): Promise<Result<AppState>>;
  listVaults(): Promise<Result<VaultSummary[]>>;
  save(args: unknown): Promise<Result<SaveResult>>;
}

function toApiError(err: unknown): ApiError {
  if (err instanceof PaperRouteError) return { code: err.code, message: err.message, details: err.details };
  return { code: "UNKNOWN", message: err instanceof Error ? err.message : String(err), details: {} };
}

function invalid(message: string): { ok: false; error: ApiError } {
  return { ok: false, error: { code: "UNKNOWN", message, details: {} } };
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
      if (typeof accountName !== "string" || !accountName.trim()) return invalid("Account name can't be empty");
      return attempt(() => settings.update({ accountName: accountName.trim() }));
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
        const result = await saveDocument(await requireSession(), {
          filePath,
          vaultId,
          ...(typeof title === "string" && title.trim() ? { title } : {}),
          tags: ["paper-route"],
          onDuplicate: allowDuplicate === true ? "allow" : "fail",
        });
        await settings.update({ lastVaultId: vaultId });
        return result;
      });
    },
  };
}
