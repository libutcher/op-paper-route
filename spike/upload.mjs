// M0 spike: prove the full path works end to end.
//   DesktopAuth -> vaults.list -> items.create(Document) -> items.get read-back
//
// Usage: node spike/upload.mjs <file> [--account "Butcher Family"] [--vault "PaperRouteTest"]
//
// Throwaway code. Nothing here is meant to survive into M1.

import fs from "node:fs/promises";
import path from "node:path";
import sdk from "@1password/sdk";

const MAX_BYTES = 50 * 1024 * 1024; // SDK message limit is 50 MB

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const filePath = process.argv[2];
const accountName = arg("--account", "Butcher Family");
const vaultName = arg("--vault", "PaperRouteTest");

if (!filePath || filePath.startsWith("--")) {
  console.error("usage: node spike/upload.mjs <file> [--account NAME] [--vault NAME]");
  process.exit(2);
}

const t0 = performance.now();
const lap = (label) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${label}`);

// 1. Read the file into memory. No temp copies.
const stat = await fs.stat(filePath);
if (stat.size > MAX_BYTES) {
  console.error(`file is ${stat.size} bytes; SDK limit is ${MAX_BYTES}`);
  process.exit(1);
}
const content = new Uint8Array(await fs.readFile(filePath));
lap(`read ${path.basename(filePath)} (${content.byteLength} bytes)`);

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
