import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakeClient } from "../core/fake-client.test-util.js";
import type { Connect } from "../core/session.js";
import { createHandlers } from "./handlers.js";
import { SettingsStore } from "./settings.js";

const VAULT = "v-test";
let dir: string;
let file: string;
let settingsFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-route-app-"));
  file = join(dir, "receipt.pdf");
  settingsFile = join(dir, "settings", "settings.json");
  await writeFile(file, "pdf bytes");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(client: FakeClient = fakeClient([{ id: VAULT, title: "PaperRouteTest" }])) {
  const connect = vi.fn<Connect>(async () => client);
  const settings = new SettingsStore(settingsFile);
  const handlers = createHandlers({ settings, integrationName: "tests", integrationVersion: "0", connect });
  return { handlers, settings, client, connect };
}

describe("settings", () => {
  it("starts empty, persists updates, and survives a corrupt file", async () => {
    const { settings } = setup();
    await expect(settings.get()).resolves.toEqual({ accountName: null, lastVaultId: null });

    await settings.update({ accountName: "Butcher Family" });
    await expect(new SettingsStore(settingsFile).get()).resolves.toEqual({
      accountName: "Butcher Family",
      lastVaultId: null,
    });

    await writeFile(settingsFile, "{not json");
    await expect(new SettingsStore(settingsFile).get()).resolves.toEqual({ accountName: null, lastVaultId: null });
  });
});

describe("handlers", () => {
  it("requires an account before talking to 1Password", async () => {
    const { handlers, connect } = setup();
    await expect(handlers.listVaults()).resolves.toMatchObject({ ok: false, error: { code: "ACCOUNT_NOT_FOUND" } });
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects an empty or non-string account name", async () => {
    const { handlers } = setup();
    for (const bad of ["", "   ", 42, null]) {
      await expect(handlers.setAccount(bad)).resolves.toMatchObject({ ok: false });
    }
  });

  it("stores a trimmed account name and lists vaults with it", async () => {
    const { handlers, connect } = setup();
    await expect(handlers.setAccount("  Butcher Family ")).resolves.toMatchObject({
      ok: true,
      value: { accountName: "Butcher Family" },
    });
    await expect(handlers.listVaults()).resolves.toEqual({ ok: true, value: [{ id: VAULT, title: "PaperRouteTest" }] });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ accountName: "Butcher Family" }));
  });

  it("reuses one session across calls (one approval prompt per process)", async () => {
    const { handlers, connect } = setup();
    await handlers.setAccount("Butcher Family");
    await handlers.listVaults();
    await handlers.save({ filePath: file, vaultId: VAULT });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("starts a new session when the account changes", async () => {
    const { handlers, connect } = setup();
    await handlers.setAccount("One");
    await handlers.listVaults();
    await handlers.setAccount("Two");
    await handlers.listVaults();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ accountName: "Two" }));
  });

  it("saves with the paper-route tag and remembers the vault", async () => {
    const { handlers, client, settings } = setup();
    await handlers.setAccount("Butcher Family");

    const result = await handlers.save({ filePath: file, vaultId: VAULT, title: "Dentist" });

    expect(result).toMatchObject({ ok: true, value: { title: "Dentist", vaultId: VAULT } });
    expect(client.items.create).toHaveBeenCalledWith(expect.objectContaining({ tags: ["paper-route"] }));
    await expect(settings.get()).resolves.toMatchObject({ lastVaultId: VAULT });
  });

  it("defaults the title to the file name when the title is blank", async () => {
    const { handlers } = setup();
    await handlers.setAccount("Butcher Family");
    await expect(handlers.save({ filePath: file, vaultId: VAULT, title: "  " })).resolves.toMatchObject({
      ok: true,
      value: { title: "receipt.pdf" },
    });
  });

  it("returns core errors with their code and details, and doesn't remember the vault on failure", async () => {
    const { handlers, client, settings } = setup();
    await handlers.setAccount("Butcher Family");
    client.seed({ id: "existing", title: "receipt.pdf", vaultId: VAULT, category: "Document" as never });

    await expect(handlers.save({ filePath: file, vaultId: VAULT })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: "DUPLICATE_TITLE", details: { title: "receipt.pdf", itemId: "existing" } }),
    });
    await expect(settings.get()).resolves.toMatchObject({ lastVaultId: null });

    // Allowed on request.
    await expect(handlers.save({ filePath: file, vaultId: VAULT, allowDuplicate: true })).resolves.toMatchObject({
      ok: true,
    });
  });

  it("validates save arguments from the window before doing anything", async () => {
    const { handlers, connect } = setup();
    await handlers.setAccount("Butcher Family");
    const bad: unknown[] = [
      null,
      "receipt.pdf",
      { vaultId: VAULT },
      { filePath: "relative/receipt.pdf", vaultId: VAULT },
      { filePath: file },
      { filePath: file, vaultId: "" },
      { filePath: file, vaultId: VAULT, title: 7 },
    ];
    for (const args of bad) {
      await expect(handlers.save(args), JSON.stringify(args)).resolves.toMatchObject({ ok: false });
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("writes the settings file privately", async () => {
    const { handlers } = setup();
    await handlers.setAccount("Butcher Family");
    const { mode } = await import("node:fs/promises").then((fs) => fs.stat(settingsFile));
    expect(mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({ accountName: "Butcher Family", lastVaultId: null });
  });
});
