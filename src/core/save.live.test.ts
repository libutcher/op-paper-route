/**
 * Live test against the real 1Password app. Prompts for approval, so it only
 * runs when asked for:
 *
 *   PAPER_ROUTE_LIVE=1 PAPER_ROUTE_ACCOUNT="<account>" npm test
 *
 * It creates one small Document in the test vault and deletes it again, so it
 * leaves nothing behind. Vault defaults to "PaperRouteTest"; override with
 * PAPER_ROUTE_TEST_VAULT.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sdk from "@1password/sdk";
import { describe, expect, it } from "vitest";
import { saveDocument } from "./save.js";
import { Session } from "./session.js";
import { findVault } from "./vaults.js";

const ACCOUNT = process.env["PAPER_ROUTE_ACCOUNT"];
const VAULT = process.env["PAPER_ROUTE_TEST_VAULT"] ?? "PaperRouteTest";

describe.skipIf(!ACCOUNT)("live: saveDocument against the 1Password app", () => {
  it(
    "saves a file, verifies it, and cleans up after itself",
    async () => {
      const session = new Session({
        accountName: ACCOUNT!,
        integrationName: "PaperRoute live test",
        integrationVersion: "0",
      });
      const vault = await findVault(session, VAULT);

      const dir = await mkdtemp(join(tmpdir(), "paper-route-live-"));
      const fileName = `live-test-${new Date().toISOString()}.txt`;
      const title = fileName.slice(0, -".txt".length); // the default title drops the extension
      const filePath = join(dir, fileName);
      const bytes = new TextEncoder().encode(`PaperRoute live test ${fileName}\n`);
      await writeFile(filePath, bytes);

      let itemId: string | undefined;
      try {
        const result = await saveDocument(session, {
          filePath,
          vaultId: vault.id,
          tags: ["paper-route", "live-test"],
        });
        itemId = result.itemId;

        expect(result).toMatchObject({ vaultId: vault.id, title, fileName, bytes: bytes.byteLength });

        const listed = await session.run((c) => c.items.list(vault.id));
        expect(listed.find((i) => i.id === itemId)).toMatchObject({
          title,
          category: sdk.ItemCategory.Document,
          tags: expect.arrayContaining(["paper-route", "live-test"]),
        });
      } finally {
        if (itemId) await session.run((c) => c.items.delete(vault.id, itemId!));
        await rm(dir, { recursive: true, force: true });
      }

      const after = await session.run((c) => c.items.list(vault.id));
      expect(after.find((i) => i.id === itemId)).toBeUndefined();
    },
    90_000,
  );
});
