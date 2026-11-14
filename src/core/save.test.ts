import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sdk from "@1password/sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakeClient } from "./fake-client.test-util.js";
import { ALWAYS_FITS_BYTES, MAX_ENCODED_BYTES, NEVER_FITS_BYTES } from "./limits.js";
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
    const params = vi.mocked(client.items.create).mock.calls[0]![0] as object;
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

  it("rejects a file that can never fit from its size alone, even past Node's 2 GiB read limit", async () => {
    const { session, client } = setup();
    // Sparse file: 3 GiB on paper, no disk space used. readFile would throw
    // ERR_FS_FILE_TOO_LARGE, which used to surface as FILE_UNREADABLE.
    const giant = join(dir, "giant.iso");
    await truncate(giant, 3 * 1024 ** 3).catch(async () => {
      await writeFile(giant, "");
      await truncate(giant, 3 * 1024 ** 3);
    });

    const started = performance.now();
    const err = await saveDocument(session, { filePath: giant, vaultId: VAULT }).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: "FILE_TOO_LARGE",
      details: { fileName: "giant.iso", bytes: 3 * 1024 ** 3, maxFileBytes: NEVER_FITS_BYTES - 1 },
    });
    expect((err as { details: object }).details).not.toHaveProperty("encoded");
    // Rejected without reading 3 GiB into memory.
    expect(performance.now() - started).toBeLessThan(500);
    expect(session.isConnected).toBe(false);
    expect(client.items.create).not.toHaveBeenCalled();
  });

  it("counts notes against the limit, so a file near the limit with long notes is refused before any prompt", async () => {
    // All zeros encode to 2n + 1; pick n so the file alone fits with ~100 KB spare.
    const n = Math.floor((MAX_ENCODED_BYTES - 100 * 1024) / 2);
    const nearLimit = join(dir, "near-limit.bin");
    await writeFile(nearLimit, new Uint8Array(n));

    const withoutNotes = setup();
    await expect(saveDocument(withoutNotes.session, { filePath: nearLimit, vaultId: VAULT })).resolves.toMatchObject({
      bytes: n,
    });

    const withNotes = setup();
    const err = await saveDocument(withNotes.session, {
      filePath: nearLimit,
      vaultId: VAULT,
      notes: "x".repeat(200 * 1024),
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(withNotes.session.isConnected).toBe(false);
    expect(withNotes.client.items.create).not.toHaveBeenCalled();
  });

  it("still reads and checks exactly when the size alone can't decide", async () => {
    const { session } = setup();
    // In the "unknown" band, all zeros: small enough encoded to fit.
    const borderline = join(dir, "borderline.bin");
    await writeFile(borderline, new Uint8Array(ALWAYS_FITS_BYTES + 1));

    await expect(saveDocument(session, { filePath: borderline, vaultId: VAULT })).resolves.toMatchObject({
      bytes: ALWAYS_FITS_BYTES + 1,
    });
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

  it("does not retry create after a session expiry, and the next save reconnects", async () => {
    const { session, client } = setup();
    client.failNext("create", new sdk.DesktopSessionExpiredError("expired"));

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    expect(client.items.create).toHaveBeenCalledTimes(1);
    expect(session.isConnected).toBe(false);

    // The user tries again: a fresh connection, and the save goes through.
    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).resolves.toMatchObject({ itemId: "item-1" });
  });

  it("never creates a second copy when a create succeeds but reports the session expired", async () => {
    const { session, client } = setup();
    const realCreate = client.items.create;
    client.items.create = vi.fn(async (params: Parameters<typeof realCreate>[0]) => {
      await realCreate(params); // the item lands in the vault...
      throw new sdk.DesktopSessionExpiredError("expired"); // ...but the call reports expiry
    });

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    expect(client.stored.size).toBe(1);

    // Retrying finds the item that already landed instead of making another.
    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).rejects.toMatchObject({
      code: "DUPLICATE_TITLE",
    });
    expect(client.stored.size).toBe(1);
  });

  it("still retries read-only steps after a session expiry", async () => {
    const { session, client } = setup();
    client.failNext("list", new sdk.DesktopSessionExpiredError("expired"));

    await expect(saveDocument(session, { filePath: smallFile, vaultId: VAULT })).resolves.toMatchObject({ itemId: "item-1" });
    expect(client.items.list).toHaveBeenCalledTimes(2);
  });
});
