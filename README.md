# PaperRoute

A small macOS utility for getting a document you just downloaded into a 1Password vault with as little friction as possible: one Touch ID, drop the file, done.

Built on the official [1Password JavaScript SDK](https://github.com/1Password/onepassword-sdk-js) with desktop-app authentication, so there are no tokens or service accounts: the 1Password app itself approves each session, and the app can reach every vault you can, including your Private vault.

## Status

Usable, and packaged as a Mac app. It isn't signed with an Apple Developer ID yet, so on a Mac other than the one it was built on, macOS asks you to allow it once (see [Installing](#installing)).

| Milestone | State |
|---|---|
| M0 Prove an upload works end to end | Done |
| M1 Core library with tests, and a CLI | Done |
| M2 Desktop app: menu bar, hotkey, drop zone, vault picker | Done |
| M3 Getting files in: Finder Quick Action, drop on the menu-bar icon, optional move to Trash | Done |
| M4a Packaged app: disk image, app icon, hardened runtime, locked-down Electron | Done |
| M4b Developer ID signing and notarisation | Needs an Apple Developer membership |

## Installing

Requirements: macOS on Apple silicon or Intel, and the 1Password desktop app with **Settings → Developer → Integrate with 1Password SDKs** turned on.

1. Open `PaperRoute-<version>-<arch>.dmg` and drag **PaperRoute** to **Applications**.
2. Open it from Applications. Because the app isn't signed with a Developer ID yet, macOS may refuse the first time: go to **System Settings → Privacy & Security**, find the message about PaperRoute, and choose **Open Anyway**. You only do this once.
3. To add the Finder Quick Action, click the paper-plane icon in the menu bar and choose **Install Finder Quick Action…**.

To build the disk image yourself: `npm install`, then `npm run dmg` (it lands in `out/`).

## Using the app

PaperRoute lives in the menu bar as a small paper-plane icon, with no Dock icon. Press **Control-Option-P** (or click the icon) to open its window:

1. The first time, enter your 1Password account name: open 1Password and copy the name at the very top of the sidebar, above your vaults. PaperRoute checks it with 1Password straight away and tells you if it doesn't match. It's forgiving about capitals and apostrophe style, but otherwise the name must match exactly; there's no way for an app to list your 1Password accounts for you.
2. Approve the request in 1Password. Approval lasts until 1Password locks or ten minutes pass without use.
3. Give it a document: drop it on the window, drop it on the menu-bar icon, choose one, or use the Finder Quick Action below. The title fills in from the file name and the last vault you used is already selected.
4. Press **Return**. **Esc** hides the window.

If a document with the same title is already in the vault, PaperRoute asks before saving another. If you hand it a file while a save is in progress, that file waits and loads when the save finishes. Saved documents are tagged `paper-route`.

**Move the original to the Trash after saving** (a checkbox, off by default) cleans up as you go. The file is moved only after the document has been read back from 1Password and matched, and only if it hasn't changed since it was read; it goes to the Trash rather than being deleted, so it can be recovered.

Settings (the account name, last vault and Trash option) are kept in `~/Library/Application Support/paper-route/settings.json`; nothing secret is stored there.

### Finder Quick Action

Install it from the menu-bar icon: **Install Finder Quick Action…** (the same item removes it again). It adds **Save to 1Password with PaperRoute** to Finder: right-click a file → **Quick Actions**. PaperRoute opens with the file loaded; press Return to save. If PaperRoute is already running, the file goes to that copy, so there's no second approval. With several files selected, the first is used. The Quick Action finds PaperRoute by its bundle identifier, so it keeps working wherever the app is installed.

**A new Quick Action may start switched off.** If it isn't in the Quick Actions menu, turn it on in **System Settings → General → Login Items & Extensions → Extensions → Finder** (click the ⓘ). It's also available under **Services** at the bottom of the right-click menu.

## Using the CLI

Runs from source: Node 20 or later, `npm install`, and the same 1Password setting as the app.

```sh
export PAPER_ROUTE_ACCOUNT="<account name as shown in the 1Password sidebar>"

npm run vaults                                   # list vaults with their ids
npm run save -- ~/Downloads/receipt.pdf --vault "Personal Docs"
npm run save -- scan.pdf --vault <vault-id> --title "Dentist, March" --tag receipts
```

The first call prompts for approval in the 1Password app. Approval lasts ten minutes of inactivity, per process.

If two vaults share a name, `--vault` must be the id. A second document with the same title in the same vault is refused unless you pass `--allow-duplicate`.

## Development

Needs Node 20 or later.

```sh
npm install
npm start              # build and run from source
npm test               # unit tests against an in-memory fake; never prompts
npm run typecheck
npm run build          # compile to dist/ (npm start does this too)
npm run package        # build out/PaperRoute-darwin-<arch>/PaperRoute.app
npm run dmg            # package, then build out/PaperRoute-<version>-<arch>.dmg
npm run render-icons   # re-render the menu-bar and app icons from assets/*.svg
npm run install-quick-action     # Quick Action for this source copy (the packaged app installs its own)
PAPER_ROUTE_USER_DATA=/tmp/pr-test npm start   # run with separate settings, e.g. to see the first-run screen
PAPER_ROUTE_LIVE=1 npm test   # also runs the live test against the real app (one prompt)
```

The live test creates one small document in the vault named by `PAPER_ROUTE_TEST_VAULT` (default `PaperRouteTest`) and deletes it again.

If Electron starts and immediately exits with an error about `app` being undefined, `ELECTRON_RUN_AS_NODE` is set in your shell (VS Code's terminal sets it). `npm start` clears it; to run Electron by hand, use `env -u ELECTRON_RUN_AS_NODE npx electron .`. The packaged app ignores it (see below).

### Packaging

`npm run package` signs the app **ad hoc** with the hardened runtime, using `build/entitlements.plist`:

- `allow-jit` for Electron's JavaScript engine;
- `disable-library-validation`, so the hardened app can load 1Password's SDK library, which is signed by 1Password's team rather than ours.

It also flips Electron's **fuses** before signing, so the shipped app can't be made to run other code: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` are ignored, and the app runs only its own `app.asar`, whose hash is checked at launch.

**Test the packaged app the way users launch it:** from Finder, or with `open`. Started from a terminal inside VS Code, macOS treats VS Code as responsible for it, so 1Password's approval prompt names VS Code instead of PaperRoute.

Signing with a Developer ID and notarising (M4b) needs an Apple Developer membership; only the signing identity in `scripts/package.mjs` changes, plus a notarisation step.

### Layout

- `src/core/` — everything that talks to 1Password, with no UI dependencies. `Session` owns the one long-lived SDK client; `saveDocument` reads a file, checks it fits, creates the item, reads it back and verifies the bytes; `listVaults` and `findVault`; `PaperRouteError` with a `code` the UI can switch on.
- `src/app/` — the Electron main process. `main.ts` sets up the menu-bar icon, shortcut and window; `handlers.ts` implements each request from the window; `account-names.ts` decides which spellings of an account name to try; `handoff.ts` takes files from Finder, the menu-bar icon and other launches; `preload.cts` is the only bridge into the sandboxed window. Everything but `main.ts` and the preload is free of Electron imports, so it can be tested.
- `src/renderer/` — the window: a sandboxed page with no Node access.
- `src/shared/` — types, the window ↔ main-process API, and `window-logic.ts`: the window's decisions (when to offer Try Again, when a 1Password prompt is likely, how titles are filled in), kept out of the DOM code so they can be tested.
- `src/cli.ts` — the command-line interface, built on the core.
- `src/app/quick-action.ts` — builds the Finder Quick Action's workflow; used by the app's menu and by `scripts/quick-action.mjs`.
- `scripts/` — packaging (`package.mjs`, `make-dmg.mjs`), icon rendering, and the development Quick Action installer.
- `assets/` and `build/` — icon sources and outputs, and the entitlements.

## Things worth knowing about the SDK

Found while building this; none of it is in the SDK documentation.

- **The real file limit is about 14 MB, not 50 MB.** The SDK caps each message at 50 MB, but it serializes file bytes as a JSON array of decimal numbers, so each byte of file costs 2–4 bytes of message. `src/core/limits.ts` computes the exact encoded size before asking for approval.
- **Authorization is per process.** Each new process gets its own approval prompt, which is why the app must keep a single long-lived client rather than spawning one per save.
- **Locking 1Password doesn't raise the SDK's session-expired error.** The next call waits while 1Password prompts again (minutes, if nobody answers), then fails with a plain `invalid client id`. A denied prompt, and a locked app whose unlock is cancelled, both give `Denied authorization for SDK client`. `src/core/errors.ts` maps these exact messages; the UI should show that it's waiting for 1Password.
- **Vault titles are not unique.** Always select and remember vaults by id.
- **Empty files read back as a plain `[]`**, not a `Uint8Array`; the SDK's JSON reviver only converts non-empty byte arrays.
- Desktop auth works by `dlopen`-ing `libop_sdk_ipc_client.dylib` from inside the 1Password app bundle, so the SDK needs a real Node process; it cannot run in a browser or a plain WebView.
