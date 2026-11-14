/**
 * The slice of the 1Password SDK client that PaperRoute uses. Keeping it
 * narrow means tests can run against an in-memory fake, and the real
 * `Client` satisfies it structurally (checked at compile time in session.ts).
 */

import type { FileAttributes, Item, ItemCreateParams, ItemOverview, VaultOverview } from "@1password/sdk";

export interface OnePasswordClient {
  vaults: {
    list(): Promise<VaultOverview[]>;
  };
  items: {
    list(vaultId: string): Promise<ItemOverview[]>;
    create(params: ItemCreateParams): Promise<Item>;
    delete(vaultId: string, itemId: string): Promise<void>;
    files: {
      read(vaultId: string, itemId: string, attr: FileAttributes): Promise<Uint8Array>;
    };
  };
}
