/**
 * Save one local file into a vault as a Document item, and prove it landed.
 *
 * Order matters: everything that can fail without 1Password (reading the
 * file, the size check) happens before the first SDK call, so a bad file never
 * costs the user an approval prompt. After the item is created, the bytes are
 * read back and compared; if that fails the item is deleted so a failed save
 * leaves nothing behind.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import sdk from "@1password/sdk";
import type { ItemCreateParams } from "@1password/sdk";
import { PaperRouteError, fromSdkError, messageFor } from "./errors.js";
import { checkFits } from "./limits.js";
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

  // 1. Read into memory. No temp copies; the path itself is never stored in the item.
  let content: Uint8Array;
  try {
    content = new Uint8Array(await readFile(request.filePath));
  } catch (err) {
    throw new PaperRouteError("FILE_UNREADABLE", `${messageFor("FILE_UNREADABLE")}: ${fileName}`, {
      cause: err,
      details: { fileName },
    });
  }

  // 2. Will it fit in one SDK message? Decided before any prompt.
  const fit = checkFits(content);
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
  const created = await session.run((client) => client.items.create(params));

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
      if (!Buffer.from(roundTrip).equals(content)) {
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
