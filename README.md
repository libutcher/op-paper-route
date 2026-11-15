# PaperRoute

An unofficial macOS utility that lets you save a document to 1Password with as little friction as possible. Built on the [1Password JavaScript SDK](https://github.com/1Password/onepassword-sdk-js), with Touch ID authentication from the 1Password desktop app.

<p align="left">
  <img src="docs/demo-dark.gif" width="350" alt="PaperRoute connecting to 1Password, receiving a file from Finder, and saving it to a vault, in dark mode">
</p>

> **Version 0.1**. PaperRoute works end to end, but development is in progress. Issues and feedback are welcome.

## What's included

- **A menu-bar app.** A paper-plane icon in the menu bar, no Dock icon. Press **Control-Option-P** to open a small utility where you can drop a document, choose a title and vault, then save it in 1Password. Or drop a file directly on the menu-bar icon to start the process.
- **A Finder Quick Action.** Right-click a file > **Quick Actions** > **Save to 1Password with PaperRoute**, and the utility opens with the file loaded. 
- **Optional clean-up.** A checkbox moves the original to the Trash once the document is safely in 1Password.

PaperRoute never reads information stored in 1Password. Every session is approved by you, in the 1Password app, the same way you unlock it.

## Requirements

- **macOS** on Apple silicon (an Intel build can be made from source).
- **The 1Password desktop app**, with **Settings** > **Developer** > **Integrate with 1Password SDKs** turned on. 

## Step 1: Install PaperRoute

1. Download `PaperRoute-<version>-arm64.dmg` from the [latest release](https://github.com/libutcher/op-paper-route/releases/latest), open it, and drag **PaperRoute** to **Applications**. Each release also lists the file's SHA-256 checksum; to check your download, run `shasum -a 256` on it and compare.
2. Open it from Applications. PaperRoute isn't signed with an Apple Developer ID yet, so macOS may refuse the first time. If this happens, go to **System Settings → Privacy & Security**, find the message about PaperRoute, and choose **Open Anyway**. You only have to do this once.
3. (Optional) To save files from Finder's right-click menu, click the paper-plane icon in the top menu bar and choose **Install Finder Quick Action…**. The same menu item removes it again. 

To build the disk image yourself, see [Development](#development).

## Step 2: Enter your 1Password account name

When you first open PaperRoute, enter the name of the 1Password account where you want to file documents:

1. Open the 1Password desktop app and find your account name at the top of the left sidebar.
2. Enter that name in PaperRoute and select **Continue**. 
3. Approve the request in 1Password.

Account names are matched without regard to capitalization or apostrophe style, but otherwise must match exactly. PaperRoute can't list your accounts for you.

1Password controls approval. It lasts while PaperRoute is running, until 1Password locks or ten minutes pass without use. When approval expires, PaperRoute asks again the next time it needs access.

To switch to a different account, select **Choose Account…** from the paper-plane menu-bar icon. PaperRoute forgets the current account and prompts you to enter a new account name. 

### Save a document

PaperRoute can currently save one document at a time. Support for multiple document upload is coming in a future update.

If a document with the same title is already in the vault, PaperRoute asks before saving another. Saved documents are tagged `paper-route`.

If you choose to move the file to trash, the file is moved only after the document has been read back from 1Password and matched byte for byte, and only if it hasn't changed since it was read. It goes to the Trash, not deleted, so it can be recovered. PaperRoute remembers this setting.

### From the app

1. Drop the document you want to upload into the app, or choose a file to save in 1Passowrd.
2. Choose a title for the new item in 1Password, like `Dentist Receipt, March 2026`. PaperRoute uses the file name if left blank.
3. (Optional) Select the checbox to "Move the original to the Trash after saving" if you want to delete the original file. 
4. Select **Save to 1Password**. A new item with the file will be added to the vault. 

### From Finder

After you turn on Quick Access from the PaperRoute menu-bar icon:

1. Open Finder and navigate to the file you want to save in 1Password. 
2. Right-click the file and select **Quick Actions** > **Save to 1Password with PaperRoute**.
3. The app will open with the file ready to upload. Enter a name for the 1Password item, choose a vault, and select **Save to 1Password**.

## Troubleshooting

- **The Quick Action isn't in the right-click menu.** New Quick Actions can start switched off. Turn it on in **System Settings → General → Login Items & Extensions → Extensions → Finder** (click the ⓘ). It's also available under **Services** at the bottom of the right-click menu.
- **"Waiting for 1Password"** means 1Password is showing you an approval prompt, or is locked. Unlock it or approve the request, and PaperRoute carries on.
- **"PaperRoute can't find the 1Password account … any more."** The account was renamed or signed out of 1Password. Check its name at the top of the 1Password sidebar and enter it again.
- **Large files.** The 1Password SDK can't accept files over about 14 MB. PaperRoute says so before asking for approval.

Settings (the account name, the last vault and the Trash option) are kept in `~/Library/Application Support/paper-route/settings.json`. Nothing secret is stored there.

## Development

Building from source needs **Node 20 or later** (and macOS, for packaging and the Quick Action). `npm run dmg` builds the disk image into `out/`.

```sh
npm install
npm start              # build and run from source
npm test               # unit tests against an in-memory fake; never prompts
npm run typecheck
npm run build          # compile to dist/ (npm start does this too)
npm run package        # build out/PaperRoute-darwin-<arch>/PaperRoute.app
npm run dmg            # package, then build out/PaperRoute-<version>-<arch>.dmg
npm run demo           # re-record docs/demo-dark.gif from the built window
npm run render-icons   # re-render the menu-bar and app icons from assets/*.svg
npm run install-quick-action     # Quick Action for this source copy (the packaged app installs its own)
PAPER_ROUTE_USER_DATA=/tmp/pr-test npm start   # run with separate settings, e.g. to see the first-run screen
```

### Live test

The live test connects to the real 1Password app, prompts you for approval, creates a small document in the vault specified by `PAPER_ROUTE_TEST_VAULT` (default `PaperRouteTest`), and deletes it again. Run it only when you're ready to use that vault:

```sh
PAPER_ROUTE_LIVE=1 npm test
```

### Testing the core from the command line

A small CLI exercises the core library (`src/core/`) against the real 1Password app without the window, which is useful when changing the save logic or chasing an SDK behaviour.

```sh
export PAPER_ROUTE_ACCOUNT="<account name as shown in the 1Password sidebar>"

npm run vaults                                   # list vaults with their ids
npm run save -- ~/Downloads/receipt.pdf --vault PaperRouteTest
npm run save -- scan.pdf --vault "YOUR_VAULT_ID" --title "Dentist, March" --tag receipts
```

Replace `<account name as shown in the 1Password sidebar>` with your account name and `YOUR_VAULT_ID` with a vault ID from `npm run vaults`. The first call prompts for approval in the 1Password app. If two vaults share a name, `--vault` must be the ID. A second document with the same title in the same vault is refused unless you pass `--allow-duplicate`. Every failure prints as one line with its error code, the same codes the window switches on.

If Electron starts and immediately exits with an error about `app` being undefined, `ELECTRON_RUN_AS_NODE` is set in your shell (VS Code's terminal sets it). `npm start` clears it; to run Electron by hand, use `env -u ELECTRON_RUN_AS_NODE npx electron .`. The packaged app ignores the variable.

### Layout

- `src/core/` — everything that talks to 1Password, with no UI dependencies. `Session` owns the one long-lived SDK client; `saveDocument` reads a file, checks it fits, creates the item, reads it back and verifies the bytes; `listVaults` and `findVault`; `PaperRouteError` with a `code` the UI can switch on.
- `src/app/` — the Electron main process. `main.ts` sets up the menu-bar icon, shortcut and window; `handlers.ts` implements each request from the window; `account-names.ts` decides which spellings of an account name to try; `handoff.ts` takes files from Finder, the menu-bar icon and other launches; `quick-action.ts` builds the Finder Quick Action's workflow; `preload.cts` is the only bridge into the sandboxed window. Everything but `main.ts` and the preload is free of Electron imports, so it can be tested.
- `src/renderer/` — the window: a sandboxed page with no Node access.
- `src/shared/` — types, the window ↔ main-process API, and `window-logic.ts`: the window's decisions (when to offer Try Again, when a 1Password prompt is likely, how titles are filled in), kept out of the DOM code so they can be tested.
- `src/cli.ts` — the testing CLI, built on the core.
- `scripts/` — packaging (`package.mjs`, `make-dmg.mjs`), icon rendering, the development Quick Action installer, and the demo recorder (`demo/`).
- `assets/`, `build/`, `docs/` — icon sources and outputs, the entitlements, and the demo.

