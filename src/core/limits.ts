/**
 * File-size limits imposed by the 1Password SDK.
 *
 * The SDK caps each serialized message crossing its FFI boundary at 50 MB
 * (`messageLimit` in @1password/sdk-core). That limit is on the *message*, not
 * the file: a Uint8Array is serialized as a JSON array of decimal numbers
 * ("[37,80,68,...]"), so every byte of file costs 2–4 bytes of message. Typical
 * binary files (PDFs, images) average about 3.6, which puts the practical
 * ceiling for a document around 14 MB.
 *
 * Everything here is pure and synchronous so the UI can call it freely.
 */

/** Hard limit on a serialized SDK message, in bytes. */
export const SDK_MESSAGE_LIMIT = 50 * 1024 * 1024;

/**
 * Space reserved for the fixed parts of the message: JSON keys, ids and the
 * invocation envelope. User-supplied fields are measured separately; see checkFits.
 */
export const MESSAGE_HEADROOM = 64 * 1024;

/** Largest encoded file payload that fits inside one message. */
export const MAX_ENCODED_BYTES = SDK_MESSAGE_LIMIT - MESSAGE_HEADROOM;

/**
 * A file of this many bytes or fewer always fits, whatever its contents.
 * Worst case is every byte >= 100 ("255,"): encoded = 4n + 1.
 */
export const ALWAYS_FITS_BYTES = Math.floor((MAX_ENCODED_BYTES - 1) / 4);

/**
 * A file of this many bytes or more never fits, whatever its contents.
 * Best case is every byte < 10 ("7,"): encoded = 2n + 1.
 */
export const NEVER_FITS_BYTES = Math.floor((MAX_ENCODED_BYTES - 1) / 2) + 1;

/**
 * Exact length of `JSON.stringify(Array.from(bytes))`, without building the string.
 * Brackets + (n - 1) commas + the decimal digits of every byte.
 */
export function encodedSize(bytes: Uint8Array): number {
  const n = bytes.byteLength;
  if (n === 0) return 2; // "[]"
  let digits = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    digits += b < 10 ? 1 : b < 100 ? 2 : 3;
  }
  return 2 + (n - 1) + digits;
}

export type FitCheck =
  | { fits: true; encoded: number; limit: number }
  | { fits: false; encoded: number; limit: number };

/**
 * Decide whether these exact bytes fit in one SDK message alongside
 * `metadataBytes` of other user-supplied content (title, notes, tags), which
 * is unbounded and so can't come out of the fixed headroom. `limit` is the
 * space left for the file once the metadata is accounted for.
 */
export function checkFits(bytes: Uint8Array, metadataBytes = 0): FitCheck {
  const encoded = encodedSize(bytes);
  const limit = MAX_ENCODED_BYTES - metadataBytes;
  return { fits: encoded <= limit, encoded, limit };
}

/** UTF-8 length of the user-supplied fields as they'll appear in the serialized message. */
export function metadataSize(fields: Record<string, string | string[] | undefined>): number {
  return Buffer.byteLength(JSON.stringify(fields), "utf8");
}

/**
 * Cheap verdict from a file size alone (e.g. from `stat`), before reading anything.
 * "unknown" means the answer depends on the contents; read the file and use `checkFits`.
 */
export function sizeHint(fileSize: number): "fits" | "too-large" | "unknown" {
  if (fileSize <= ALWAYS_FITS_BYTES) return "fits";
  if (fileSize >= NEVER_FITS_BYTES) return "too-large";
  return "unknown";
}
