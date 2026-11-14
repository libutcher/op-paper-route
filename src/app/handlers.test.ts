import { existsSync } from "node:fs";
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
  // Stands in for Electron's shell.trashItem: really removes the file, so tests can see it's gone.
  const trash = vi.fn(async (path: string) => {
    await rm(path);
  });
  const handlers = createHandlers({ settings, integrationName: "tests", integrationVersion: "0", connect, trash });
  return { handlers, settings, client, connect, trash };
}

describe("settings", () => {
  it("starts empty, persists updates, and survives a corrupt file", async () => {
    const { settings } = setup();
    await expect(settings.get()).resolves.toEqual({ accountName: null, lastVaultId: null, trashAfterSave: false, approveEverySave: false });

    await settings.update({ accountName: "Example Family" });
    await expect(new SettingsStore(settingsFile).get()).resolves.toEqual({
      accountName: "Example Family",
      lastVaultId: null,
      trashAfterSave: false,
      approveEverySave: false,
    });

    await writeFile(settingsFile, "{not json");
    await expect(new SettingsStore(settingsFile).get()).resolves.toEqual({
      accountName: null,
      lastVaultId: null,
      trashAfterSave: false,
      approveEverySave: false,
    });
  });

  it("keeps both changes when two updates overlap", async () => {
    const settings = new SettingsStore(settingsFile);

    const [first, second] = await Promise.all([
      settings.update({ accountName: "Example Family" }),
      settings.update({ lastVaultId: "v-test" }),
    ]);

    expect(first).toEqual({ accountName: "Example Family", lastVaultId: null, trashAfterSave: false, approveEverySave: false });
    expect(second).toEqual({ accountName: "Example Family", lastVaultId: "v-test", trashAfterSave: false, approveEverySave: false });
    // And on disk, read fresh.
    await expect(new SettingsStore(settingsFile).get()).resolves.toEqual({
      accountName: "Example Family",
      lastVaultId: "v-test",
      trashAfterSave: false,
      approveEverySave: false,
    });
    // No temp files left behind.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(join(dir, "settings"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps working after a failed update", async () => {
    // A directory where the settings file should be makes the rename fail.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(settingsFile, { recursive: true });
    const settings = new SettingsStore(settingsFile);

    await expect(settings.update({ accountName: "A" })).rejects.toThrow();
    await rm(settingsFile, { recursive: true });
    await expect(settings.update({ lastVaultId: "v" })).resolves.toMatchObject({ lastVaultId: "v" });
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
      await expect(handlers.setAccount(bad)).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
  });

  describe("checking the account name", () => {
    /** A connect() that knows exactly one account name, like the real SDK: exact match only. */
    function onlyAccount(realName: string, outcome?: Error) {
      const client = fakeClient([{ id: VAULT, title: "PaperRouteTest" }]);
      const connect = vi.fn<Connect>(async ({ accountName }) => {
        if (accountName !== realName) {
          throw new Error("An error occurred when processing SDK request: Error { msg: Account not found, inner: None }");
        }
        if (outcome) throw outcome;
        return client;
      });
      const settings = new SettingsStore(settingsFile);
      const handlers = createHandlers({ settings, integrationName: "t", integrationVersion: "0", connect, trash: vi.fn() });
      return { handlers, settings, connect };
    }

    it("saves a name that connects, exactly as typed", async () => {
      const { handlers, connect } = onlyAccount("Example Family");
      await expect(handlers.setAccount("Example Family")).resolves.toMatchObject({
        ok: true,
        value: { accountName: "Example Family" },
      });
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("finds the account when only the capitals were wrong, and saves the name that worked", async () => {
      const { handlers, settings } = onlyAccount("Example Family");
      await expect(handlers.setAccount("  example family ")).resolves.toMatchObject({
        ok: true,
        value: { accountName: "Example Family" },
      });
      await expect(settings.get()).resolves.toMatchObject({ accountName: "Example Family" });
    });

    it("finds the account when the apostrophe style differs", async () => {
      const { handlers } = onlyAccount("Lucy’s Family");
      await expect(handlers.setAccount("Lucy's Family")).resolves.toMatchObject({
        ok: true,
        value: { accountName: "Lucy’s Family" },
      });
    });

    it("keeps the session it checked with, so loading vaults doesn't ask for approval again", async () => {
      const { handlers, connect } = onlyAccount("Example Family");
      await handlers.setAccount("example family");
      const attempts = connect.mock.calls.length;

      await expect(handlers.listVaults()).resolves.toMatchObject({ ok: true });
      expect(connect).toHaveBeenCalledTimes(attempts);
    });

    it("refuses a name that doesn't match, explains why, and saves nothing", async () => {
      const { handlers, settings } = onlyAccount("Example Family");
      await settings.update({ accountName: "Previous Account" });

      const result = await handlers.setAccount("Exampel Family");

      expect(result).toMatchObject({ ok: false, error: { code: "ACCOUNT_NOT_FOUND", details: { typed: "Exampel Family" } } });
      expect(result.ok ? "" : result.error.message).toContain("including capital letters");
      await expect(settings.get()).resolves.toMatchObject({ accountName: "Previous Account" });
    });

    it("stops at the first real problem instead of trying other spellings", async () => {
      const denied = new Error(
        "An error occurred when processing SDK request: Error { msg: Denied authorization for SDK client, inner: None }",
      );
      const { handlers, settings, connect } = onlyAccount("Example Family", denied);

      await expect(handlers.setAccount("Example Family")).resolves.toMatchObject({
        ok: false,
        error: { code: "NOT_AUTHORIZED" },
      });
      expect(connect).toHaveBeenCalledTimes(1);
      await expect(settings.get()).resolves.toMatchObject({ accountName: null });
    });
  });

  it("stores a trimmed account name and lists vaults with it", async () => {
    const { handlers, connect } = setup();
    await expect(handlers.setAccount("  Example Family ")).resolves.toMatchObject({
      ok: true,
      value: { accountName: "Example Family" },
    });
    await expect(handlers.listVaults()).resolves.toEqual({ ok: true, value: [{ id: VAULT, title: "PaperRouteTest" }] });
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ accountName: "Example Family" }));
  });

  it("reuses one session across calls (one approval prompt per process)", async () => {
    const { handlers, connect } = setup();
    await handlers.setAccount("Example Family");
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
    await handlers.setAccount("Example Family");

    const result = await handlers.save({ filePath: file, vaultId: VAULT, title: "Dentist" });

    expect(result).toMatchObject({ ok: true, value: { title: "Dentist", vaultId: VAULT } });
    expect(client.items.create).toHaveBeenCalledWith(expect.objectContaining({ tags: ["paper-route"] }));
    await expect(settings.get()).resolves.toMatchObject({ lastVaultId: VAULT });
  });

  it("defaults the title to the file name when the title is blank", async () => {
    const { handlers } = setup();
    await handlers.setAccount("Example Family");
    await expect(handlers.save({ filePath: file, vaultId: VAULT, title: "  " })).resolves.toMatchObject({
      ok: true,
      value: { title: "receipt.pdf" },
    });
  });

  it("returns core errors with their code and details, and doesn't remember the vault on failure", async () => {
    const { handlers, client, settings } = setup();
    await handlers.setAccount("Example Family");
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

  it("reports a save as successful even if remembering the vault fails", async () => {
    const { handlers, client, settings } = setup();
    await handlers.setAccount("Example Family");
    // Block the settings file so the next write fails.
    const { mkdir } = await import("node:fs/promises");
    await rm(settingsFile);
    await mkdir(settingsFile);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({ ok: true });

    expect(client.stored.size).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("couldn't remember the vault"));
    await expect(settings.get()).resolves.toMatchObject({ lastVaultId: null });
    warn.mockRestore();
  });

  it("validates save arguments from the window before doing anything", async () => {
    const { handlers, connect } = setup();
    await handlers.setAccount("Example Family");
    connect.mockClear(); // setting the account connects to check it; that's not under test here
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
      await expect(handlers.save(args), JSON.stringify(args)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST" },
      });
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it("writes the settings file privately", async () => {
    const { handlers } = setup();
    await handlers.setAccount("Example Family");
    const { mode } = await import("node:fs/promises").then((fs) => fs.stat(settingsFile));
    expect(mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toEqual({
      accountName: "Example Family",
      lastVaultId: null,
      trashAfterSave: false,
      approveEverySave: false,
    });
  });
});

describe("move to Trash after saving", () => {
  async function withTrashOn(client?: FakeClient) {
    const s = setup(client);
    await s.handlers.setAccount("Example Family");
    await s.handlers.setTrashAfterSave(true);
    return s;
  }

  it("is off by default: the original stays and Trash is never touched", async () => {
    const { handlers, trash } = setup();
    await handlers.setAccount("Example Family");

    await expect(handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({
      ok: true,
      value: { original: "kept" },
    });
    expect(trash).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
  });

  it("moves the original to the Trash once the document is stored and verified", async () => {
    const { handlers, trash, client } = await withTrashOn();

    await expect(handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({
      ok: true,
      value: { original: "trashed" },
    });
    expect(trash).toHaveBeenCalledWith(file);
    expect(existsSync(file)).toBe(false);
    expect(client.stored.size).toBe(1);
  });

  it("remembers the option, accepts only true or false, and treats anything else on disk as off", async () => {
    const { handlers } = setup();
    await expect(handlers.setTrashAfterSave(true)).resolves.toMatchObject({ ok: true, value: { trashAfterSave: true } });
    await expect(new SettingsStore(settingsFile).get()).resolves.toMatchObject({ trashAfterSave: true });

    for (const bad of ["yes", 1, null, undefined]) {
      await expect(handlers.setTrashAfterSave(bad)).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }

    await writeFile(settingsFile, JSON.stringify({ trashAfterSave: "yes" }));
    await expect(new SettingsStore(settingsFile).get()).resolves.toMatchObject({ trashAfterSave: false, approveEverySave: false });
  });

  it("leaves the original alone when the save fails", async () => {
    const { handlers, trash, client } = await withTrashOn();
    client.seed({ id: "existing", title: "receipt.pdf", vaultId: VAULT, category: "Document" as never });

    await expect(handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({
      ok: false,
      error: { code: "DUPLICATE_TITLE" },
    });
    expect(trash).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
  });

  it("leaves the original alone when verification fails", async () => {
    const { handlers, trash, client } = await withTrashOn();
    client.corruptNextRead(new TextEncoder().encode("different"));

    await expect(handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({
      ok: false,
      error: { code: "VERIFY_FAILED" },
    });
    expect(trash).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
  });

  it("keeps a file that changed during the save, since 1Password has the old version", async () => {
    const client = fakeClient([{ id: VAULT, title: "PaperRouteTest" }]);
    const realCreate = client.items.create;
    client.items.create = vi.fn(async (params: Parameters<typeof realCreate>[0]) => {
      const item = await realCreate(params);
      // The user (or a download finishing) writes a newer version mid-save.
      await writeFile(file, "a newer, longer version of the pdf");
      return item;
    });
    const { handlers, trash } = await withTrashOn(client);

    await expect(handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({
      ok: true,
      value: { original: "changed" },
    });
    expect(trash).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("a newer, longer version of the pdf");
  });

  it("uses the Trash setting as it is when the save finishes, not when it started", async () => {
    // The user unticks the box while the save waits (e.g. for approval).
    const client = fakeClient([{ id: VAULT, title: "PaperRouteTest" }]);
    const realCreate = client.items.create;
    let handlersRef: ReturnType<typeof setup>["handlers"] | null = null;
    client.items.create = vi.fn(async (params: Parameters<typeof realCreate>[0]) => {
      await handlersRef!.setTrashAfterSave(false);
      return realCreate(params);
    });
    const unticked = await withTrashOn(client);
    handlersRef = unticked.handlers;

    await expect(unticked.handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({
      ok: true,
      value: { original: "kept" },
    });
    expect(unticked.trash).not.toHaveBeenCalled();
    expect(existsSync(file)).toBe(true);
  });

  it("honours the box being ticked during a save, too", async () => {
    const client = fakeClient([{ id: VAULT, title: "PaperRouteTest" }]);
    const realCreate = client.items.create;
    let handlersRef: ReturnType<typeof setup>["handlers"] | null = null;
    client.items.create = vi.fn(async (params: Parameters<typeof realCreate>[0]) => {
      await handlersRef!.setTrashAfterSave(true);
      return realCreate(params);
    });
    const ticked = setup(client);
    handlersRef = ticked.handlers;
    await ticked.handlers.setAccount("Example Family");

    await expect(ticked.handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({
      ok: true,
      value: { original: "trashed" },
    });
    expect(existsSync(file)).toBe(false);
  });

  it("still reports the save as successful when moving to the Trash fails", async () => {
    const { handlers, trash, client } = await withTrashOn();
    trash.mockRejectedValueOnce(new Error("Trash unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({
      ok: true,
      value: { original: "failed" },
    });
    expect(existsSync(file)).toBe(true);
    expect(client.stored.size).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("couldn't move the original to the Trash"));
    warn.mockRestore();
  });
});

describe("dropping 1Password's approval", () => {
  it("dropSession() makes the next call connect (and prompt) again, and tells the window", async () => {
    const client = fakeClient([{ id: VAULT, title: "PaperRouteTest" }]);
    const connect = vi.fn<Connect>(async () => client);
    const onSessionDropped = vi.fn();
    const settings = new SettingsStore(settingsFile);
    const handlers = createHandlers({ settings, integrationName: "t", integrationVersion: "0", connect, trash: vi.fn(), onSessionDropped });
    await handlers.setAccount("Example Family");
    await handlers.listVaults();
    const before = connect.mock.calls.length;

    handlers.dropSession();
    expect(onSessionDropped).toHaveBeenCalledTimes(1);

    await expect(handlers.listVaults()).resolves.toMatchObject({ ok: true });
    expect(connect).toHaveBeenCalledTimes(before + 1);
  });

  it("is harmless before any session exists", () => {
    const { handlers } = setup();
    expect(() => handlers.dropSession()).not.toThrow();
  });

  it("with 'approve every save' on, each save ends the approval; the next one connects again", async () => {
    const client = fakeClient([{ id: VAULT, title: "PaperRouteTest" }]);
    const connect = vi.fn<Connect>(async () => client);
    const onSessionDropped = vi.fn();
    const settings = new SettingsStore(settingsFile);
    const handlers = createHandlers({ settings, integrationName: "t", integrationVersion: "0", connect, trash: vi.fn(), onSessionDropped });
    await handlers.setAccount("Example Family");
    await expect(handlers.setApproveEverySave(true)).resolves.toMatchObject({ ok: true, value: { approveEverySave: true } });
    const before = connect.mock.calls.length;

    await expect(handlers.save({ filePath: file, vaultId: VAULT })).resolves.toMatchObject({ ok: true });
    expect(connect).toHaveBeenCalledTimes(before); // the save itself reused the approval
    expect(onSessionDropped).toHaveBeenCalledTimes(1); // and ended it afterwards

    await writeFile(file, "pdf bytes"); // the first save may have moved nothing; make sure the file is there
    await expect(handlers.save({ filePath: file, vaultId: VAULT, title: "second" })).resolves.toMatchObject({ ok: true });
    expect(connect).toHaveBeenCalledTimes(before + 1); // the next save had to connect again
  });

  it("with the option off, saves share one approval", async () => {
    const { handlers, connect } = setup();
    await handlers.setAccount("Example Family");
    const before = connect.mock.calls.length;
    await handlers.save({ filePath: file, vaultId: VAULT });
    await handlers.save({ filePath: file, vaultId: VAULT, title: "second" });
    expect(connect).toHaveBeenCalledTimes(before);
  });

  it("setApproveEverySave accepts only true or false, and anything else on disk means off", async () => {
    const { handlers } = setup();
    for (const bad of ["yes", 1, null]) {
      await expect(handlers.setApproveEverySave(bad)).resolves.toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    // Saving once creates the settings file; then overwrite it with a non-boolean.
    await handlers.setApproveEverySave(true);
    await writeFile(settingsFile, JSON.stringify({ approveEverySave: "yes" }));
    await expect(new SettingsStore(settingsFile).get()).resolves.toMatchObject({ approveEverySave: false });
  });
});
