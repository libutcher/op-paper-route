import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sdk from "@1password/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeClient, type FakeClient } from "./fake-client.test-util.js";
import { ALWAYS_FITS_BYTES } from "./limits.js";
import { saveDocument } from "./save.js";
import { Session } from "./session.js";

const VAULT = "v-test";
let dir: string;
let smallFile: string;
let emptyFile: string;
let hugeFile: string;
const smallBytes = new TextEncoder().encode("Paper Route save test\n");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-route-save-"));
  smallFile = join(dir, "receipt.txt");
  emptyFile = join(dir, "empty.txt");
  hugeFile = join(dir, "huge.bin");
  await writeFile(smallFile, smallBytes);
  await writeFile(emptyFile, new Uint8Array(0));
  // One byte past the always-fits bound, all worst-case bytes: guaranteed too large.
  await writeFile(hugeFile, new Uint8Array(ALWAYS_FITS_BYTES + 1).fill(255));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(client: FakeClient = fakeClient([{ id: VAULT, title: "PaperRouteTest" }])) {
  const session = new Session({
    accountName: "Test",
    integrationName: "tests",
    integrationVersion: "0",
    connect: async () => client,
  });
  return { session, client };
}

describe("saveDocument", () => {
  it("creates a Document item named after the file, verifies it, and reports the result", async () => {
    const { session, client } = setup();

    const result = await saveDocument(session, { filePath: smallFile, vaultId: VAULT });

    expect(result).toEqual({
      itemId: "item-1",
      vaultId: VAULT,
      title: "receipt.txt",
      fileName: "receipt.txt",
      bytes: smallBytes.byteLength,
    });
    expect(client.items.create).toHaveBeenCalledWith({
      category: sdk.ItemCategory.Document,
      vaultId: VAULT,
      title: "receipt.txt",
      document: { name: "receipt.txt", content: smallBytes },
    });
    expect(client.items.files.read).toHaveBeenCalledTimes(1);
    expect(client.items.delete).not.toHaveBeenCalled();
    expect(client.stored.size).toBe(1);
  });

  it("passes title, tags and notes through, keeping the file name on the document", async () => {
    const { session, client } = setup();

    const result = await saveDocument(session, {
      filePath: smallFile,
      vaultId: VAULT,
      title: "  Dentist receipt  ",
      tags: ["paper-route", "health"],
      notes: "March visit",
    });

    expect(result.title).toBe("Dentist receipt");
    expect(client.items.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Dentist receipt",
        tags: ["paper-route", "health"],
        notes: "March visit",
        document: expect.objectContaining({ name: "receipt.txt" }),
      }),
    );
  });

  it("does not send undefined tags or notes", async () => {
    const { session, client } = setup();
    await saveDocument(session, { filePath: smallFile, vaultId: VAULT });
    const params = (client.items.create as ReturnType<typeof import("vitest").vi.fn>).mock.calls[0]![0] as object;
    expect(params).not.toHaveProperty("tags");
    expect(params).not.toHaveProperty("notes");
  });

  it("saves an empty file and still verifies it (SDK returns [] for empty reads)", async () => {
    const { session } = setup();
    const result = await saveDocument(session, { filePath: emptyFile, vaultId: VAULT });
    expect(result.bytes).toBe(0);
  });

  it("fails with FILE_UNREADABLE before touching 1Password", async () => {
    const { session, client } = setup();

    await expect(saveDocument(session, { filePath: join(dir, "missing.pdf"), vaultId: VAULT })).rejects.toMatchObject({
      code: "FILE_UNREADABLE",
      details: { fileName: "missing.pdf" },
    });
    expect(session.isConnected).toBe(false);
    expect(client.items.create).not.toHaveBeenCalled();
  });

  it("fails with FILE_TOO_LARGE before touching 1Password, with the sizes involved", async () => {
    const { session, client } = setup();

    const err = await saveDocument(session, { filePath: hugeFile, vaultId: VAULT }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "FILE_TOO_LARGE", details: { fileName: "huge.bin", bytes: ALWAYS_FITS_BYTES + 1 } });
    const details = (err as { details: { encoded: number; limit: number } }).details;
    expect(details.encoded).toBeGreaterThan(details.limit);
    expect(session.isConnected).toBe(false);
    expect(client.items.create).not.toHaveBeenCalled();
  });

  it("refuses a duplicate Document title by default and names the existing item", async () => {
    const { session, client } = setup();
    client.seed({ id: "existing", title: "receipt.txt", vaultId: VAULT, category: sdk.ItemCategory.Document });

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).rejects.toMatchObject({
      code: "DUPLICATE_TITLE",
      details: { title: "receipt.txt", itemId: "existing" },
    });
    expect(client.items.create).not.toHaveBeenCalled();
  });

  it("ignores same-titled items of other categories when checking duplicates", async () => {
    const { session, client } = setup();
    client.seed({ id: "login", title: "receipt.txt", vaultId: VAULT, category: sdk.ItemCategory.Login });

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).resolves.toMatchObject({ itemId: "item-1" });
  });

  it("ignores same-titled Documents in other vaults", async () => {
    const { session, client } = setup();
    client.seed({ id: "elsewhere", title: "receipt.txt", vaultId: "other-vault", category: sdk.ItemCategory.Document });

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).resolves.toMatchObject({ itemId: "item-1" });
  });

  it("allows duplicates when asked, without listing items first", async () => {
    const { session, client } = setup();
    client.seed({ id: "existing", title: "receipt.txt", vaultId: VAULT, category: sdk.ItemCategory.Document });

    await expect(
      saveDocument(session, { filePath: smallFile, vaultId: VAULT, onDuplicate: "allow" }),
    ).resolves.toMatchObject({ itemId: "item-1" });
    expect(client.items.list).not.toHaveBeenCalled();
    expect(client.stored.size).toBe(2);
  });

  it("deletes the item and fails with VERIFY_FAILED when the bytes read back differ", async () => {
    const { session, client } = setup();
    client.corruptNextRead(new TextEncoder().encode("not the same"));

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).rejects.toMatchObject({
      code: "VERIFY_FAILED",
      message: expect.stringContaining("the item was removed"),
      details: { itemId: "item-1", deleted: true },
    });
    expect(client.items.delete).toHaveBeenCalledWith(VAULT, "item-1");
    expect(client.stored.size).toBe(0);
  });

  it("deletes the item and fails with VERIFY_FAILED when the read-back throws", async () => {
    const { session, client } = setup();
    client.failNext("read", new Error("network wobble"));

    const err = await saveDocument(session, { filePath: smallFile, vaultId: VAULT }).catch((e: unknown) => e);

    expect(err).toMatchObject({ code: "VERIFY_FAILED", details: { itemId: "item-1", deleted: true } });
    expect((err as Error).message).toContain("network wobble");
    expect(client.stored.size).toBe(0);
  });

  it("says so when the cleanup delete also fails, so the user can remove it by hand", async () => {
    const { session, client } = setup();
    client.corruptNextRead(new Uint8Array([1]));
    client.failNext("delete", new Error("delete refused"));

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).rejects.toMatchObject({
      code: "VERIFY_FAILED",
      message: expect.stringContaining("delete it manually"),
      details: { itemId: "item-1", deleted: false },
    });
    expect(client.stored.size).toBe(1);
  });

  it("maps an SDK failure during create to a PaperRouteError and creates nothing", async () => {
    const { session, client } = setup();
    client.failNext("create", new Error("vault is read-only"));

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("vault is read-only"),
    });
    expect(client.stored.size).toBe(0);
  });

  it("recovers from a session expiry in the middle of a save", async () => {
    const first = fakeClient([{ id: VAULT, title: "PaperRouteTest" }]);
    first.failNext("create", new sdk.DesktopSessionExpiredError("expired"));
    const second = fakeClient([{ id: VAULT, title: "PaperRouteTest" }]);
    const clients = [first, second];
    const session = new Session({
      accountName: "Test",
      integrationName: "tests",
      integrationVersion: "0",
      connect: async () => clients.shift()!,
    });

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).resolves.toMatchObject({ itemId: "item-1" });
    expect(first.stored.size).toBe(0);
    expect(second.stored.size).toBe(1);
  });
});
