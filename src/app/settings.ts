/**
 * Tiny persisted settings: the account name and the last vault used. Stored
 * as JSON in Electron's userData folder. Nothing secret lives here; vault ids
 * and an account name are not credentials.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Settings {
  accountName: string | null;
  lastVaultId: string | null;
}

const DEFAULTS: Settings = { accountName: null, lastVaultId: null };

export class SettingsStore {
  readonly #file: string;
  #cache: Settings | null = null;

  constructor(file: string) {
    this.#file = file;
  }

  async get(): Promise<Settings> {
    if (!this.#cache) this.#cache = await this.#load();
    return { ...this.#cache };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch };
    await mkdir(dirname(this.#file), { recursive: true });
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    const tmp = `${this.#file}.tmp`;
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
      };
    } catch {
      // A corrupt settings file shouldn't stop the app; start fresh.
      return { ...DEFAULTS };
    }
  }
}
