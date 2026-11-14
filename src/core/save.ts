/**
 * Save one local file into a vault as a Document item, and prove it landed.
 *
 * Order matters: everything that can fail without 1Password (reading the
 * file, the size check) happens before the first SDK call, so a bad file never
 * costs the user an approval prompt. After the item is created, the bytes are
 * read back and compared; if that fails the item is deleted so a failed save
 * leaves nothing behind.
 */

import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import sdk from "@1password/sdk";
import type { ItemCreateParams } from "@1password/sdk";
import { PaperRouteError, fromSdkError, messageFor } from "./errors.js";
import { MAX_ENCODED_BYTES, NEVER_FITS_BYTES, checkFits, metadataSize, sizeHint } from "./limits.js";
import type { Session } from "./session.js";

export interface SaveRequest {
  filePath: string;
  vaultId: string;
  /** Item title. Defaults to the file name. */
  title?: string;
  tags?: string[];
  notes?: string;
  /**
   * What to do when a Document with the same title already exists in the vault.
   * 1Password itself allows duplicates; the default refuses so a retried save
   * can't pile up copies.
   */
  onDuplicate?: "fail" | "allow";
}

export interface SaveResult {
  itemId: string;
  vaultId: string;
  title: string;
  fileName: string;
  bytes: number;
}

export async function saveDocument(session: Session, request: SaveRequest): Promise<SaveResult> {
  const fileName = basename(request.filePath);
  const title = request.title?.trim() || fileName;

  const unreadable = (err: unknown) =>
    new PaperRouteError("FILE_UNREADABLE", `${messageFor("FILE_UNREADABLE")}: ${fileName}`, {
      cause: err,
      details: { fileName },
    });
  const tooLargeBySize = (bytes: number, cause?: unknown) =>
    new PaperRouteError("FILE_TOO_LARGE", `${messageFor("FILE_TOO_LARGE")}: ${fileName}`, {
      cause,
      details: { fileName, bytes, limit: MAX_ENCODED_BYTES, maxFileBytes: NEVER_FITS_BYTES - 1 },
    });

  // 1. A file that can't fit whatever its contents is rejected from its size
  //    alone, without reading it into memory.
  let size: number;
  try {
    size = (await stat(request.filePath)).size;
  } catch (err) {
    throw unreadable(err);
  }
  if (sizeHint(size) === "too-large") throw tooLargeBySize(size);

  // 2. Read into memory. No temp copies; the path itself is never stored in the item.
  //    The exact check below still runs on what was read, in case the file
  //    changed after the stat.
  let content: Uint8Array;
  try {
    const buffer = await readFile(request.filePath);
    // A plain Uint8Array *view* of the same memory: no copy. It must not be the
    // Buffer itself, because JSON.stringify calls Buffer.toJSON() before the
    // SDK's replacer sees it and the bytes would be sent as {"type":"Buffer",...}.
    content = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (err) {
    // Node refuses to read files over 2 GiB; that's a size problem, not an unreadable file.
    if ((err as NodeJS.ErrnoException).code === "ERR_FS_FILE_TOO_LARGE") throw tooLargeBySize(size, err);
    throw unreadable(err);
  }

  // 3. Will these exact bytes fit in one SDK message? Decided before any prompt.
  const metadata = metadataSize({ title, name: fileName, notes: request.notes, tags: request.tags });
  const fit = checkFits(content, metadata);
  if (!fit.fits) {
    throw new PaperRouteError("FILE_TOO_LARGE", `${messageFor("FILE_TOO_LARGE")}: ${fileName}`, {
      details: { fileName, bytes: content.byteLength, encoded: fit.encoded, limit: fit.limit },
    });
  }

  // 3. Refuse duplicates unless told otherwise.
  if ((request.onDuplicate ?? "fail") === "fail") {
    const existing = await session.run((client) => client.items.list(request.vaultId));
    const duplicate = existing.find((i) => i.category === sdk.ItemCategory.Document && i.title === title);
    if (duplicate) {
      throw new PaperRouteError("DUPLICATE_TITLE", `${messageFor("DUPLICATE_TITLE")}: "${title}"`, {
        details: { title, itemId: duplicate.id },
      });
    }
  }

  // 4. Create the item.
  const params: ItemCreateParams = {
    category: sdk.ItemCategory.Document,
    vaultId: request.vaultId,
    title,
    document: { name: fileName, content },
    ...(request.tags ? { tags: request.tags } : {}),
    ...(request.notes ? { notes: request.notes } : {}),
  };
  // No automatic retry: if the session expires mid-create, the item may already
  // exist, and retrying here would skip the duplicate check above. The caller
  // gets SESSION_EXPIRED; the user's next attempt re-runs the whole save.
  const created = await session.run((client) => client.items.create(params), { reauth: false });

  // 5. Read it back and compare. Any failure here deletes the item.
  let problem: PaperRouteError | null = null;
  try {
    const attributes = created.document;
    if (!attributes) {
      problem = new PaperRouteError("VERIFY_FAILED", "The created item has no document attached");
    } else {
      const raw = await session.run((client) => client.items.files.read(request.vaultId, created.id, attributes));
      // The SDK only revives non-empty byte arrays into a Uint8Array; an empty
      // file comes back as a plain []. Normalise before comparing.
      const roundTrip = raw instanceof Uint8Array ? raw : Uint8Array.from(raw as ArrayLike<number>);
      if (Buffer.compare(roundTrip, content) !== 0) {
        problem = new PaperRouteError("VERIFY_FAILED", "The bytes read back from 1Password differ from the file");
      }
    }
  } catch (err) {
    const cause = fromSdkError(err);
    problem = new PaperRouteError("VERIFY_FAILED", `${messageFor("VERIFY_FAILED")}: ${cause.message}`, { cause });
  }

  if (problem) {
    try {
      await session.run((client) => client.items.delete(request.vaultId, created.id));
    } catch (err) {
      throw new PaperRouteError(
        "VERIFY_FAILED",
        `${problem.message}; the item could not be removed, delete it manually`,
        { cause: err, details: { itemId: created.id, deleted: false } },
      );
    }
    throw new PaperRouteError("VERIFY_FAILED", `${problem.message}; the item was removed`, {
      cause: problem.cause,
      details: { itemId: created.id, deleted: true },
    });
  }

  return { itemId: created.id, vaultId: request.vaultId, title, fileName, bytes: content.byteLength };
}
