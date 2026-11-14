// M0 spike: prove the full path works end to end.
//   DesktopAuth -> vaults.list -> items.create(Document) -> items.get read-back
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

// 2. Authenticate via the desktop app. Expect a Touch ID prompt here.
console.log(`connecting to 1Password as "${accountName}" — approve the prompt in the 1Password app`);
const client = await sdk.createClient({
  auth: new sdk.DesktopAuth(accountName),
  integrationName: "Paper Route (spike)",
  integrationVersion: "v0.0.0",
});
lap("authenticated");

// 3. Find the target vault by title.
const vaults = await client.vaults.list();
lap(`listed ${vaults.length} vault(s): ${vaults.map((v) => v.title).join(", ")}`);
const vault = vaults.find((v) => v.title === vaultName);
if (!vault) {
  console.error(`vault "${vaultName}" not found in account "${accountName}"`);
  process.exit(1);
}

// 4. Create the Document item.
const title = path.basename(filePath);
const created = await client.items.create({
  category: sdk.ItemCategory.Document,
  vaultId: vault.id,
  title,
  tags: ["paper-route", "spike"],
  notes: `Uploaded by Paper Route spike from ${filePath}`,
  document: { name: title, content },
});
lap(`created item ${created.id} "${created.title}" in "${vault.title}"`);

// 5. Read it back and verify the bytes match.
const fetched = await client.items.get(vault.id, created.id);
const roundTrip = await client.items.files.read(vault.id, fetched.id, fetched.document);
const same =
  roundTrip.byteLength === content.byteLength &&
  roundTrip.every((b, i) => b === content[i]);
lap(`read back ${roundTrip.byteLength} bytes — ${same ? "MATCH" : "MISMATCH"}`);

process.exit(same ? 0 : 1);
