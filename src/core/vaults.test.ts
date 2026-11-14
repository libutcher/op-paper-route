import { describe, expect, it } from "vitest";
import { fakeClient } from "./fake-client.test-util.js";
import { Session } from "./session.js";
import { findVault, listVaults } from "./vaults.js";

const VAULTS = [
  { id: "v-shop-2", title: "Shopping" },
  { id: "v-docs", title: "Personal Docs" },
  { id: "v-shop-1", title: "Shopping" },
  { id: "v-test", title: "PaperRouteTest" },
];

function session() {
  return new Session({
    accountName: "Test",
    integrationName: "tests",
    integrationVersion: "0",
    connect: async () => fakeClient(VAULTS),
  });
}

describe("listVaults", () => {
  it("returns id and title only, sorted by title then id", async () => {
    await expect(listVaults(session())).resolves.toEqual([
      { id: "v-test", title: "PaperRouteTest" },
      { id: "v-docs", title: "Personal Docs" },
      { id: "v-shop-1", title: "Shopping" },
      { id: "v-shop-2", title: "Shopping" },
    ]);
  });
});

describe("findVault", () => {
  it("finds by id", async () => {
    await expect(findVault(session(), "v-shop-2")).resolves.toEqual({ id: "v-shop-2", title: "Shopping" });
  });

  it("finds by title when exactly one vault has it", async () => {
    await expect(findVault(session(), "PaperRouteTest")).resolves.toEqual({ id: "v-test", title: "PaperRouteTest" });
  });

  it("refuses an ambiguous title and lists the candidate ids", async () => {
    await expect(findVault(session(), "Shopping")).rejects.toMatchObject({
      code: "VAULT_AMBIGUOUS",
      details: { title: "Shopping", matches: 2, ids: "v-shop-1,v-shop-2" },
    });
  });

  it("reports a missing vault", async () => {
    await expect(findVault(session(), "Nope")).rejects.toMatchObject({
      code: "VAULT_NOT_FOUND",
      details: { query: "Nope" },
    });
  });

  it("prefers an id match over a title match", async () => {
    const client = fakeClient([{ id: "Shopping", title: "Other" }, { id: "x", title: "Shopping" }]);
    const s = new Session({ accountName: "T", integrationName: "t", integrationVersion: "0", connect: async () => client });
    await expect(findVault(s, "Shopping")).resolves.toEqual({ id: "Shopping", title: "Other" });
  });
});
