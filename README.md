# Paper Route

A small macOS utility for getting a document you just downloaded into a 1Password vault with as little friction as possible: one Touch ID, drop the file, done.

Built on the official [1Password JavaScript SDK](https://github.com/1Password/onepassword-sdk-js) with desktop-app authentication, so there are no tokens or service accounts: the 1Password app itself approves each session, and the app can reach every vault you can, including your Private vault.

## Status

Work in progress. The core library and a command-line interface exist; the desktop app does not yet.

| Milestone | State |
|---|---|
| M0 Prove an upload works end to end | Done |
| M1 Core library with tests, and a CLI | Done |
| M2 Electron shell: menu bar, drop zone, vault picker | Next |
| M3 Friction removal: Finder Quick Action, hotkey, remember vault | |
| M4 Signed and notarized build | |

## Using the CLI

Requirements: Node 20 or later, the 1Password desktop app with **Settings → Developer → Integrate with 1Password SDKs** turned on.

```sh
npm install
export PAPER_ROUTE_ACCOUNT="<account name as shown in the 1Password sidebar>"

npm run vaults                                   # list vaults with their ids
npm run save -- ~/Downloads/receipt.pdf --vault "Personal Docs"
npm run save -- scan.pdf --vault <vault-id> --title "Dentist, March" --tag receipts
```

The first call prompts for approval in the 1Password app. Approval lasts ten minutes of inactivity, per process.

If two vaults share a name, `--vault` must be the id. A second document with the same title in the same vault is refused unless you pass `--allow-duplicate`.

## Development

```sh
npm test               # unit tests against an in-memory fake; never prompts
npm run typecheck
PAPER_ROUTE_LIVE=1 npm test   # also runs the live test against the real app (one prompt)
```

The live test creates one small document in the vault named by `PAPER_ROUTE_TEST_VAULT` (default `PaperRouteTest`) and deletes it again.

### Layout

- `src/core/` — everything that talks to 1Password, with no UI dependencies. `Session` owns the one long-lived SDK client; `saveDocument` reads a file, checks it fits, creates the item, reads it back and verifies the bytes; `listVaults` and `findVault`; `PaperRouteError` with a `code` the UI can switch on.
- `src/cli.ts` — the command-line interface, built on the core.

## Things worth knowing about the SDK

Found while building this; none of it is in the SDK documentation.

- **The real file limit is about 14 MB, not 50 MB.** The SDK caps each message at 50 MB, but it serializes file bytes as a JSON array of decimal numbers, so each byte of file costs 2–4 bytes of message. `src/core/limits.ts` computes the exact encoded size before asking for approval.
- **Authorization is per process.** Each new process gets its own approval prompt, which is why the app must keep a single long-lived client rather than spawning one per save.
- **Locking 1Password doesn't raise the SDK's session-expired error.** The next call waits while 1Password prompts again (minutes, if nobody answers), then fails with a plain `invalid client id`. A denied prompt, and a locked app whose unlock is cancelled, both give `Denied authorization for SDK client`. `src/core/errors.ts` maps these exact messages; the UI should show that it's waiting for 1Password.
- **Vault titles are not unique.** Always select and remember vaults by id.
- **Empty files read back as a plain `[]`**, not a `Uint8Array`; the SDK's JSON reviver only converts non-empty byte arrays.
- Desktop auth works by `dlopen`-ing `libop_sdk_ipc_client.dylib` from inside the 1Password app bundle, so the SDK needs a real Node process; it cannot run in a browser or a plain WebView.
