/**
 * Developer CLI for the core module. Also handy from Shortcuts or Automator.
 *
 *   npm run vaults -- [--account NAME]
 *   npm run save -- <file> --vault <id|title> [--title T] [--tag T]... [--notes N]
 *                   [--allow-duplicate] [--account NAME]
 *
 * The account comes from --account or $PAPER_ROUTE_ACCOUNT. Exit codes: 0 ok,
 * 1 a PaperRouteError (printed as "error [CODE]: message"), 2 bad usage.
 */

import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { PaperRouteError, Session, findVault, listVaults, preflightFile, saveDocument } from "./core/index.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const USAGE = `usage:
  paper-route vaults [--account NAME]
  paper-route save <file> --vault <id|title> [--title TITLE] [--tag TAG]...
                   [--notes TEXT] [--allow-duplicate] [--account NAME]

The account is the name shown in the 1Password sidebar, from --account or
$PAPER_ROUTE_ACCOUNT. The first call prompts for approval in the 1Password app.`;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function describe(err: PaperRouteError): string {
  const d = err.details;
  switch (err.code) {
    case "FILE_TOO_LARGE":
      return "encoded" in d
        ? `${err.message} (${mb(Number(d.bytes))} encodes to ${mb(Number(d.encoded))}; the limit is ${mb(Number(d.limit))})`
        : `${err.message} (${mb(Number(d.bytes))}; no file over ${mb(Number(d.maxFileBytes))} can fit)`;
    case "DUPLICATE_TITLE":
      return `${err.message} (item ${String(d.itemId)}); pass --allow-duplicate or --title to save anyway`;
    case "VAULT_AMBIGUOUS":
      return `${err.message}: ${String(d.ids).split(",").join(" or ")}`;
    case "VERIFY_FAILED":
      return d.deleted === false ? `${err.message} (item ${String(d.itemId)})` : err.message;
    default:
      return err.message;
  }
}

const OPTIONS = {
  account: { type: "string" },
  vault: { type: "string" },
  title: { type: "string" },
  tag: { type: "string", multiple: true },
  notes: { type: "string" },
  "allow-duplicate": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const SAVE_ONLY_OPTIONS = ["vault", "title", "tag", "notes", "allow-duplicate"] as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  const usage = (message: string) => {
    console.error(`${message}\n\n${USAGE}`);
    return 2;
  };

  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  // Validate the command and its arguments first, so a typo is reported as a
  // typo rather than as a missing account.
  let filePath = "";
  let vaultQuery = "";
  switch (command) {
    case "vaults": {
      if (rest.length > 0) return usage(`vaults takes no arguments, got "${rest.join(" ")}"`);
      const saveOnly = SAVE_ONLY_OPTIONS.filter((name) => values[name] !== undefined);
      if (saveOnly.length > 0) return usage(`vaults doesn't take ${saveOnly.map((n) => `--${n}`).join(", ")}`);
      break;
    }
    case "save": {
      if (rest.length !== 1) return usage("save takes exactly one file");
      if (!values.vault) return usage("save needs --vault <id|title>");
      filePath = rest[0]!;
      vaultQuery = values.vault;
      break;
    }
    default:
      return usage(`unknown command "${command}"`);
  }

  const accountName = values.account ?? process.env["PAPER_ROUTE_ACCOUNT"];
  if (!accountName) return usage("no account: pass --account NAME or set PAPER_ROUTE_ACCOUNT");

  const session = new Session({ accountName, integrationName: "Paper Route CLI", integrationVersion: version });
  const started = performance.now();
  const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;

  switch (command) {
    case "vaults": {
      const vaults = await listVaults(session);
      for (const v of vaults) console.log(`${v.id}  ${v.title}`);
      console.error(`${vaults.length} vault(s) in ${elapsed()}`);
      return 0;
    }

    case "save": {
      // Check the file before findVault, which is the first 1Password call: a
      // missing or oversized file shouldn't cost an approval prompt.
      await preflightFile(filePath);
      const vault = await findVault(session, vaultQuery);
      const result = await saveDocument(session, {
        filePath,
        vaultId: vault.id,
        ...(values.title ? { title: values.title } : {}),
        ...(values.tag ? { tags: values.tag } : {}),
        ...(values.notes ? { notes: values.notes } : {}),
        onDuplicate: values["allow-duplicate"] ? "allow" : "fail",
      });
      console.log(`saved "${result.title}" (${result.bytes} bytes) to "${vault.title}" as item ${result.itemId} in ${elapsed()}`);
      return 0;
    }
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof PaperRouteError) {
    console.error(`error [${err.code}]: ${describe(err)}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
