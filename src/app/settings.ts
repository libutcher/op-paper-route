/**
 * Tiny persisted settings: the account name, the last vault used, and the
 * Trash option. Stored as JSON in Electron's userData folder. Nothing secret
 * lives here; vault ids and an account name are not credentials.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Settings {
  accountName: string | null;
  lastVaultId: string | null;
  trashAfterSave: boolean;
}

const DEFAULTS: Settings = { accountName: null, lastVaultId: null, trashAfterSave: false };

export class SettingsStore {
  readonly #file: string;
  #cache: Settings | null = null;
  /** Updates run one at a time, each starting from the result of the last. */
  #queue: Promise<unknown> = Promise.resolve();
  #writes = 0;

  constructor(file: string) {
    this.#file = file;
  }

  async get(): Promise<Settings> {
    if (!this.#cache) this.#cache = await this.#load();
    return { ...this.#cache };
  }

  update(patch: Partial<Settings>): Promise<Settings> {
    const run = this.#queue.then(() => this.#write(patch));
    // Keep the queue going even if this update fails.
    this.#queue = run.catch(() => {});
    return run;
  }

  async #write(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch };
    await mkdir(dirname(this.#file), { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    // Each write gets its own temp name so no two writes share one.
    const tmp = `${this.#file}.${process.pid}.${++this.#writes}.tmp`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.#file);
    this.#cache = next;
    return { ...next };
  }

  async #load(): Promise<Settings> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch {
      return { ...DEFAULTS };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
      return {
        accountName: typeof parsed.accountName === "string" && parsed.accountName ? parsed.accountName : null,
        lastVaultId: typeof parsed.lastVaultId === "string" && parsed.lastVaultId ? parsed.lastVaultId : null,
        // Only an explicit true turns it on: deleting files must never be a default.
        trashAfterSave: parsed.trashAfterSave === true,
      };
    } catch {
      // A corrupt settings file shouldn't stop the app; start fresh.
      return { ...DEFAULTS };
    }
  }
}
