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
import { PaperRouteError, Session, findVault, listVaults, saveDocument } from "./core/index.js";

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

  if (values.help || !command) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }

  const accountName = values.account ?? process.env["PAPER_ROUTE_ACCOUNT"];
  if (!accountName) {
    console.error(`no account: pass --account NAME or set PAPER_ROUTE_ACCOUNT\n\n${USAGE}`);
    return 2;
  }

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
      const [filePath] = rest;
      if (!filePath || rest.length > 1) {
        console.error(`save takes exactly one file\n\n${USAGE}`);
        return 2;
      }
      if (!values.vault) {
        console.error(`save needs --vault <id|title>\n\n${USAGE}`);
        return 2;
      }
      const vault = await findVault(session, values.vault);
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

    default:
      console.error(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
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
