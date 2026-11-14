# PaperRoute

A small macOS utility for getting a document you just downloaded into a 1Password vault with as little friction as possible: one Touch ID, drop the file, done.

Built on the official [1Password JavaScript SDK](https://github.com/1Password/onepassword-sdk-js) with desktop-app authentication, so there are no tokens or service accounts: the 1Password app itself approves each session, and the app can reach every vault you can, including your Private vault.

## Status

Work in progress. The desktop app runs from source; there's no packaged build yet.

| Milestone | State |
|---|---|
| M0 Prove an upload works end to end | Done |
| M1 Core library with tests, and a CLI | Done |
| M2 Desktop app: menu bar, hotkey, drop zone, vault picker | Done |
| M3 Getting files in: Finder Quick Action, drop on the menu-bar icon, optional move to Trash | Done |
| M4 Signed and notarized build | Next |

## Using the app

Requirements: macOS, Node 20 or later, and the 1Password desktop app with **Settings → Developer → Integrate with 1Password SDKs** turned on.

```sh
npm install
npm start
```

PaperRoute lives in the menu bar as a 📄 icon, with no Dock icon. Press **Control-Option-P** (or click the icon) to open its window:

1. The first time, enter your 1Password account name, as shown at the top of the 1Password sidebar.
2. Approve the request in 1Password. Approval lasts until 1Password locks or ten minutes pass without use.
3. Give it a document: drop it on the window, drop it on the 📄 icon, choose one, or use the Finder Quick Action below. The title fills in from the file name and the last vault you used is already selected.
4. Press **Return**. **Esc** hides the window.

If a document with the same title is already in the vault, PaperRoute asks before saving another. If you hand it a file while a save is in progress, that file waits and loads when the save finishes. Saved documents are tagged `paper-route`.

**Move the original to the Trash after saving** (a checkbox, off by default) cleans up as you go. The file is moved only after the document has been read back from 1Password and matched, and only if it hasn't changed since it was read; it goes to the Trash rather than being deleted, so it can be recovered.

Settings (the account name, last vault and Trash option) are kept in `~/Library/Application Support/paper-route/settings.json`; nothing secret is stored there.

### Finder Quick Action

```sh
npm run install-quick-action     # builds the app, then installs it
npm run uninstall-quick-action
```

This adds **Save to 1Password with PaperRoute** to Finder: right-click a file → **Quick Actions** (or **Services**). PaperRoute opens with the file loaded; press Return to save. If PaperRoute is already running, the file goes to that copy, so there's no second approval. With several files selected, the first is used.

If it doesn't appear, turn it on in **System Settings → Keyboard → Keyboard Shortcuts → Services → Files and Folders**. Until there's a packaged app, the Quick Action runs PaperRoute from this folder; if you move the folder, install it again.

## Using the CLI

Same requirements as the app.

```sh
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
npm run build          # compile to dist/ (npm start does this too)
PAPER_ROUTE_LIVE=1 npm test   # also runs the live test against the real app (one prompt)
```

The live test creates one small document in the vault named by `PAPER_ROUTE_TEST_VAULT` (default `PaperRouteTest`) and deletes it again.

If Electron starts and immediately exits with an error about `app` being undefined, `ELECTRON_RUN_AS_NODE` is set in your shell (VS Code's terminal sets it). `npm start` clears it; to run Electron by hand, use `env -u ELECTRON_RUN_AS_NODE npx electron .`.

### Layout

- `src/core/` — everything that talks to 1Password, with no UI dependencies. `Session` owns the one long-lived SDK client; `saveDocument` reads a file, checks it fits, creates the item, reads it back and verifies the bytes; `listVaults` and `findVault`; `PaperRouteError` with a `code` the UI can switch on.
- `src/app/` — the Electron main process. `main.ts` sets up the menu-bar icon, shortcut and window; `handlers.ts` implements each request from the window; `handoff.ts` takes files from Finder, the menu-bar icon and other launches; `preload.cts` is the only bridge into the sandboxed window. Everything but `main.ts` and the preload is free of Electron imports, so it can be tested.
- `src/renderer/` — the window: a sandboxed page with no Node access.
- `src/shared/` — types, the window ↔ main-process API, and `window-logic.ts`: the window's decisions (when to offer Try Again, when a 1Password prompt is likely, how titles are filled in), kept out of the DOM code so they can be tested.
- `src/cli.ts` — the command-line interface, built on the core.
- `scripts/quick-action.mjs` — installs and removes the Finder Quick Action.

## Things worth knowing about the SDK

Found while building this; none of it is in the SDK documentation.

- **The real file limit is about 14 MB, not 50 MB.** The SDK caps each message at 50 MB, but it serializes file bytes as a JSON array of decimal numbers, so each byte of file costs 2–4 bytes of message. `src/core/limits.ts` computes the exact encoded size before asking for approval.
- **Authorization is per process.** Each new process gets its own approval prompt, which is why the app must keep a single long-lived client rather than spawning one per save.
- **Locking 1Password doesn't raise the SDK's session-expired error.** The next call waits while 1Password prompts again (minutes, if nobody answers), then fails with a plain `invalid client id`. A denied prompt, and a locked app whose unlock is cancelled, both give `Denied authorization for SDK client`. `src/core/errors.ts` maps these exact messages; the UI should show that it's waiting for 1Password.
- **Vault titles are not unique.** Always select and remember vaults by id.
- **Empty files read back as a plain `[]`**, not a `Uint8Array`; the SDK's JSON reviver only converts non-empty byte arrays.
- Desktop auth works by `dlopen`-ing `libop_sdk_ipc_client.dylib` from inside the 1Password app bundle, so the SDK needs a real Node process; it cannot run in a browser or a plain WebView.
