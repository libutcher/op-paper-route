/**
 * An in-memory stand-in for the 1Password SDK client, for tests. It mimics the
 * behaviours the core depends on, including the SDK quirk of returning a plain
 * [] for an empty file. Not picked up as a test: only *.test.ts files are.
 */

import sdk from "@1password/sdk";
import type { FileAttributes, Item, ItemCreateParams, ItemOverview, VaultOverview } from "@1password/sdk";
import { vi } from "vitest";
import type { OnePasswordClient } from "./client.js";

export interface FakeVault {
  id: string;
  title: string;
}

interface StoredItem {
  item: Item;
  content: Uint8Array | null;
}

export interface FakeClient extends OnePasswordClient {
  /** Items currently in the fake, by id. */
  stored: Map<string, StoredItem>;
  /** Make the next files.read return these bytes instead of what was stored. */
  corruptNextRead(bytes: Uint8Array): void;
  /** Make the next call to the named method throw. */
  failNext(method: "list" | "create" | "delete" | "read", error: Error): void;
  /** Seed an existing item without going through create(). */
  seed(overview: Partial<ItemOverview> & { id: string; title: string; vaultId: string }): void;
}

export function fakeClient(vaults: FakeVault[]): FakeClient {
  const stored = new Map<string, StoredItem>();
  const failures = new Map<string, Error>();
  let corrupt: Uint8Array | null = null;
  let nextId = 1;

  const maybeFail = (method: string) => {
    const err = failures.get(method);
    if (err) {
      failures.delete(method);
      throw err;
    }
  };

  const client: FakeClient = {
    stored,
    corruptNextRead: (bytes) => {
      corrupt = bytes;
    },
    failNext: (method, error) => {
      failures.set(method, error);
    },
    seed: (overview) => {
      const item = {
        category: sdk.ItemCategory.Login,
        tags: [],
        websites: [],
        fields: [],
        sections: [],
        files: [],
        state: sdk.ItemState.Active,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overview,
      } as unknown as Item;
      stored.set(overview.id, { item, content: null });
    },

    vaults: {
      list: vi.fn(async (): Promise<VaultOverview[]> => {
        return vaults.map((v) => ({ id: v.id, title: v.title }) as VaultOverview);
      }),
    },

    items: {
      list: vi.fn(async (vaultId: string): Promise<ItemOverview[]> => {
        maybeFail("list");
        return [...stored.values()]
          .map((s) => s.item)
          .filter((i) => i.vaultId === vaultId)
          .map((i) => i as unknown as ItemOverview);
      }),

      create: vi.fn(async (params: ItemCreateParams): Promise<Item> => {
        maybeFail("create");
        const id = `item-${nextId++}`;
        const document: FileAttributes | undefined = params.document
          ? { id: `file-${id}`, name: params.document.name, size: params.document.content.byteLength }
          : undefined;
        const item = {
          id,
          title: params.title,
          category: params.category,
          vaultId: params.vaultId,
          tags: params.tags ?? [],
          notes: params.notes ?? "",
          websites: [],
          fields: [],
          sections: [],
          files: [],
          state: sdk.ItemState.Active,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(document ? { document } : {}),
        } as unknown as Item;
        stored.set(id, { item, content: params.document ? Uint8Array.from(params.document.content) : null });
        return item;
      }),

      delete: vi.fn(async (_vaultId: string, itemId: string): Promise<void> => {
        maybeFail("delete");
        if (!stored.delete(itemId)) throw new Error(`fake: no item ${itemId}`);
      }),

      files: {
        read: vi.fn(async (_vaultId: string, itemId: string): Promise<Uint8Array> => {
          maybeFail("read");
          if (corrupt) {
            const bytes = corrupt;
            corrupt = null;
            return bytes;
          }
          const entry = stored.get(itemId);
          if (!entry?.content) throw new Error(`fake: no file on item ${itemId}`);
          // Mimic the SDK's reviver: an empty payload is a plain array, not a Uint8Array.
          return entry.content.byteLength === 0 ? ([] as unknown as Uint8Array) : entry.content;
        }),
      },
    },
  };

  return client;
}
