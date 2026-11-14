// M0 spike: prove the full path works end to end.
//   DesktopAuth -> vaults.list -> items.create(Document) -> files.read read-back
//
// Usage: node spike/upload.mjs <file> [--account "Butcher Family"] [--vault "PaperRouteTest"]
//
// Throwaway code. Nothing here is meant to survive into M1.

import fs from "node:fs/promises";
import path from "node:path";
import sdk from "@1password/sdk";

// The SDK's 50 MB limit is on the serialized message, not the file. It sends a
// Uint8Array as a JSON array of decimal numbers ("[37,80,68,...]"), so each byte
// costs 2-4 bytes of message. Typical binary files (PDFs, images) average ~3.6,
// which puts the real file-size ceiling around 14 MB; text files go further.
// Headroom covers the rest of the message (title, notes, tags, JSON keys).
const SDK_MESSAGE_LIMIT = 50 * 1024 * 1024;
const MESSAGE_HEADROOM = 64 * 1024;

// Exact length of JSON.stringify(Array.from(bytes)) without building the string.
function serializedSize(bytes) {
  if (bytes.byteLength === 0) return 2; // "[]"
  let digits = 0;
  for (const b of bytes) digits += b < 10 ? 1 : b < 100 ? 2 : 3;
  return 2 + (bytes.byteLength - 1) + digits; // brackets + commas + digits
}

const USAGE = "usage: node spike/upload.mjs <file> [--account NAME] [--vault NAME]";

function usageError(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

// Returns the value after `flag`, or `fallback` if the flag is absent.
// A flag that is present but has no value is an error, not a silent fallback.
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) usageError(`${flag} needs a value`);
  return value;
}

const filePath = process.argv[2];
if (!filePath || filePath.startsWith("--")) usageError("missing <file>");
const accountName = arg("--account", "Butcher Family");
const vaultName = arg("--vault", "PaperRouteTest");

const t0 = performance.now();
const lap = (label) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${label}`);

// 1. Read the file into memory. No temp copies. Size is checked on the bytes
//    actually read, so a file that changes between check and read can't slip past.
//    This runs before authenticating, so an oversized file never costs a Touch ID.
const content = new Uint8Array(await fs.readFile(filePath));
const encoded = serializedSize(content);
if (encoded + MESSAGE_HEADROOM > SDK_MESSAGE_LIMIT) {
  const mb = (n) => (n / 1024 / 1024).toFixed(1);
  console.error(
    `file is ${mb(content.byteLength)} MB but encodes to ${mb(encoded)} MB in the SDK message; ` +
      `the limit is ${mb(SDK_MESSAGE_LIMIT - MESSAGE_HEADROOM)} MB`,
  );
  process.exit(1);
}
lap(`read ${path.basename(filePath)} (${content.byteLength} bytes, ${encoded} encoded)`);

// Print a one-line error instead of an unhandled-rejection stack trace.
function fail(message, err) {
  console.error(err ? `${message}: ${err.message ?? err}` : message);
  process.exit(1);
}

// 2. Authenticate via the desktop app. Expect a Touch ID prompt here.
console.log(`connecting to 1Password as "${accountName}" — approve the prompt in the 1Password app`);
let client;
try {
  client = await sdk.createClient({
    auth: new sdk.DesktopAuth(accountName),
    integrationName: "Paper Route (spike)",
    integrationVersion: "v0.0.0",
  });
} catch (err) {
  fail(`could not connect to 1Password as "${accountName}"`, err);
}
lap("authenticated");

// 3. Find the target vault by title.
let vault;
try {
  const vaults = await client.vaults.list();
  lap(`listed ${vaults.length} vault(s)`);
  vault = vaults.find((v) => v.title === vaultName);
} catch (err) {
  fail("could not list vaults", err);
}
if (!vault) fail(`vault "${vaultName}" not found in account "${accountName}"`);

// 4. Refuse to create a second item with the same title, so reruns don't pile up
//    copies in the vault.
const title = path.basename(filePath);
try {
  const existing = (await client.items.list(vault.id)).find(
    (i) => i.category === sdk.ItemCategory.Document && i.title === title,
  );
  if (existing) {
    fail(`"${title}" already exists in "${vault.title}" (item ${existing.id}); delete or rename it first`);
  }
} catch (err) {
  fail(`could not list items in "${vault.title}"`, err);
}

// 5. Create the Document item.
let created;
try {
  created = await client.items.create({
    category: sdk.ItemCategory.Document,
    vaultId: vault.id,
    title,
    tags: ["paper-route", "spike"],
    // Deliberately no local path: it would expose the username and folder layout
    // to anyone the vault is shared with.
    notes: "Uploaded by Paper Route spike",
    document: { name: title, content },
  });
} catch (err) {
  fail(`could not create "${title}" in "${vault.title}"`, err);
}
lap(`created item ${created.id} "${created.title}" in "${vault.title}"`);

// 6. Read it back and verify the bytes match. If the read fails or the bytes
//    differ, delete the item so a failed run leaves nothing behind.
let problem;
try {
  // items.create already returns the document's FileAttributes, so no items.get.
  // The SDK only revives non-empty byte arrays into a Uint8Array; a zero-byte file
  // comes back as a plain [] with no byteLength. Normalise before comparing.
  const raw = await client.items.files.read(vault.id, created.id, created.document);
  const roundTrip = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
  const same = Buffer.from(roundTrip).equals(content);
  lap(`read back ${roundTrip.byteLength} bytes — ${same ? "MATCH" : "MISMATCH"}`);
  if (!same) problem = "read-back bytes did not match the file";
} catch (err) {
  problem = `could not read the item back: ${err.message ?? err}`;
}

if (problem) {
  try {
    await client.items.delete(vault.id, created.id);
    fail(`${problem}; deleted item ${created.id}`);
  } catch (err) {
    fail(`${problem}; also failed to delete item ${created.id}, remove it manually`, err);
  }
}

process.exit(0);
