import { PaperRouteError, messageFor } from "./errors.js";
import type { Session } from "./session.js";

export interface VaultSummary {
  id: string;
  title: string;
}

/**
 * Every vault the account can see, sorted by title then id.
 *
 * Titles are not unique (the M0 test account has two vaults called
 * "Shopping"), so callers must remember and select vaults by `id`.
 */
export async function listVaults(session: Session): Promise<VaultSummary[]> {
  const vaults = await session.run((client) => client.vaults.list());
  return vaults
    .map((v) => ({ id: v.id, title: v.title }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/**
 * Resolve a vault from an id, or from an exact title when exactly one vault
 * has it. Meant for the CLI and config files; the UI should pick from
 * `listVaults` and pass ids.
 */
export async function findVault(session: Session, idOrTitle: string): Promise<VaultSummary> {
  const vaults = await listVaults(session);

  const byId = vaults.find((v) => v.id === idOrTitle);
  if (byId) return byId;

  const byTitle = vaults.filter((v) => v.title === idOrTitle);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1) {
    throw new PaperRouteError("VAULT_AMBIGUOUS", `${messageFor("VAULT_AMBIGUOUS")}: "${idOrTitle}"`, {
      details: { title: idOrTitle, matches: byTitle.length, ids: byTitle.map((v) => v.id).join(",") },
    });
  }
  throw new PaperRouteError("VAULT_NOT_FOUND", `${messageFor("VAULT_NOT_FOUND")}: "${idOrTitle}"`, {
    details: { query: idOrTitle },
  });
}
