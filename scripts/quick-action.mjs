#!/usr/bin/env node
/**
 * Installs or removes the Finder Quick Action
 * "Save to 1Password with PaperRoute".
 *
 *   npm run install-quick-action     (builds the app first)
 *   npm run uninstall-quick-action
 *
 * The Quick Action is an Automator workflow in ~/Library/Services whose one
 * step runs a shell script. The script launches PaperRoute from this folder
 * with the selected files; if PaperRoute is already running, the new launch
 * hands the files to it and exits, so there's no second 1Password approval.
 *
 * Automator's file format isn't documented. This mirrors the "Run Shell
 * Script" action in macOS's own /System/Library/Services/Show Map.workflow.
 * The plists are written as JSON and converted with plutil, so nothing is
 * hand-escaped into XML.
 *
 * Until there's a packaged app (M4), the Quick Action points at this folder.
 * If you move the folder, run the install again.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MENU_TITLE = "Save to 1Password with PaperRoute";
export const SERVICES_DIR = join(homedir(), "Library", "Services");
export const WORKFLOW_PATH = join(SERVICES_DIR, `${MENU_TITLE}.workflow`);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Quote a string for a POSIX shell: wrap in single quotes, and end/escape/reopen around any single quote. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** The script the Quick Action runs. Finder passes the selected files as arguments. */
export function launcherScript(repoDir) {
  return `# PaperRoute Quick Action: hand the selected files to PaperRoute.
# Written by scripts/quick-action.mjs; reinstall rather than editing.
REPO=${shellQuote(repoDir)}
ELECTRON="$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
if [ ! -x "$ELECTRON" ] || [ ! -f "$REPO/dist/app/main.js" ]; then
  osascript -e 'display alert "PaperRoute isn’t ready" message "Run npm install and npm run build in the PaperRoute folder, then try again."' >/dev/null 2>&1
  exit 1
fi
# VS Code's terminal sets this, and Electron then starts as plain Node with no app.
unset ELECTRON_RUN_AS_NODE
# Starts PaperRoute, or hands the files to the copy already running. Run in
# the background so Finder isn't kept waiting while the app is open.
nohup "$ELECTRON" "$REPO" "$@" >/dev/null 2>&1 &
`;
}

/** The workflow's Info.plist: registers the Finder service. */
export function infoPlist() {
  return {
    CFBundleDevelopmentRegion: "en_US",
    CFBundleName: MENU_TITLE,
    NSServices: [
      {
        // An icon is what makes Finder list this under Quick Actions in the
        // right-click menu; without one it's a plain Service, under Services.
        // These are the values Automator writes for a Quick Action.
        NSIconName: "NSActionTemplate",
        NSBackgroundColorName: "background",
        NSMenuItem: { default: MENU_TITLE },
        NSMessage: "runWorkflowAsService",
        NSRequiredContext: { NSApplicationIdentifier: "com.apple.finder" },
        // Files only; folders and app bundles can't be saved as documents.
        NSSendFileTypes: ["public.data"],
      },
    ],
  };
}

/** The workflow itself: one "Run Shell Script" step that receives files as arguments. */
export function documentWflow(command) {
  return {
    AMApplicationBuild: "534.1",
    AMApplicationVersion: "2.10",
    AMDocumentVersion: "2",
    actions: [
      {
        action: {
          AMAccepts: { Container: "List", Optional: true, Types: ["com.apple.cocoa.string"] },
          AMActionVersion: "2.0.3",
          AMApplication: ["Automator"],
          AMParameterProperties: { COMMAND_STRING: {}, CheckedForUserDefaultShell: {}, inputMethod: {}, shell: {}, source: {} },
          AMProvides: { Container: "List", Types: ["com.apple.cocoa.string"] },
          ActionBundlePath: "/System/Library/Automator/Run Shell Script.action",
          ActionName: "Run Shell Script",
          ActionParameters: {
            COMMAND_STRING: command,
            CheckedForUserDefaultShell: true,
            // 1 = pass input as arguments ("$@"), rather than on stdin.
            inputMethod: 1,
            shell: "/bin/zsh",
            source: "",
          },
          BundleIdentifier: "com.apple.RunShellScript",
          CFBundleVersion: "2.0.3",
          CanShowSelectedItemsWhenRun: false,
          CanShowWhenRun: true,
          Category: ["AMCategoryUtilities"],
          "Class Name": "RunShellScriptAction",
          InputUUID: "6A2B5E7C-0D4E-4F3A-9B21-7C1D2E3F4A01",
          Keywords: ["Shell", "Script", "Command", "Run", "Unix"],
          OutputUUID: "6A2B5E7C-0D4E-4F3A-9B21-7C1D2E3F4A02",
          UUID: "6A2B5E7C-0D4E-4F3A-9B21-7C1D2E3F4A03",
          UnlocalizedApplications: ["Automator"],
          arguments: {
            0: { "default value": 0, name: "inputMethod", required: "0", type: "0", uuid: "0" },
            1: { "default value": "", name: "source", required: "0", type: "0", uuid: "1" },
            2: { "default value": false, name: "CheckedForUserDefaultShell", required: "0", type: "0", uuid: "2" },
            3: { "default value": "", name: "COMMAND_STRING", required: "0", type: "0", uuid: "3" },
            4: { "default value": "/bin/sh", name: "shell", required: "0", type: "0", uuid: "4" },
          },
          isViewVisible: true,
          location: "309.500000:631.000000",
          nibPath: "/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib",
        },
        isViewVisible: true,
      },
    ],
    connectors: {},
    workflowMetaData: {
      // Quick Action presentation, as Automator writes it: the icon, and the
      // places Finder may offer it.
      systemImageName: "NSActionTemplate",
      presentationMode: 15,
      serviceApplicationBundleID: "com.apple.finder",
      serviceApplicationPath: "/System/Library/CoreServices/Finder.app",
      serviceInputTypeIdentifier: "com.apple.Automator.fileSystemObject",
      serviceOutputTypeIdentifier: "com.apple.Automator.nothing",
      serviceProcessesInput: 0,
      workflowTypeIdentifier: "com.apple.Automator.servicesMenu",
    },
  };
}

/** Write `value` to `path` as an XML property list, via JSON and plutil. */
async function writePlist(path, value) {
  const scratch = await mkdtemp(join(tmpdir(), "paper-route-plist-"));
  try {
    const json = join(scratch, "in.json");
    await writeFile(json, JSON.stringify(value));
    execFileSync("plutil", ["-convert", "xml1", "-o", path, json]);
    execFileSync("plutil", ["-lint", "-s", path]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Build the workflow bundle at `bundlePath` (replacing any old one) with the given shell script. */
export async function writeWorkflow(bundlePath, command) {
  if (!bundlePath.endsWith(".workflow")) throw new Error(`Refusing to write a workflow to ${bundlePath}`);
  await removeWorkflow(bundlePath);
  const contents = join(bundlePath, "Contents");
  await mkdir(contents, { recursive: true });
  await writePlist(join(contents, "Info.plist"), infoPlist());
  await writePlist(join(contents, "document.wflow"), documentWflow(command));
}

/** Remove the workflow bundle at `bundlePath`, if it's there. Only ever a *.workflow bundle. */
export async function removeWorkflow(bundlePath) {
  if (!bundlePath.endsWith(".workflow") || basename(bundlePath) === ".workflow") {
    throw new Error(`Refusing to remove ${bundlePath}: not a .workflow bundle`);
  }
  await rm(bundlePath, { recursive: true, force: true });
}

/** Ask macOS to re-read the Services folder, so the menu updates without logging out. */
function refreshServices() {
  try {
    execFileSync("/System/Library/CoreServices/pbs", ["-update"], { stdio: "ignore" });
  } catch {
    // Not fatal: Finder picks the change up on its own, if more slowly.
  }
}

async function main(command) {
  if (process.platform !== "darwin") throw new Error("Quick Actions are macOS only.");
  if (command === "install") {
    if (!existsSync(join(REPO, "dist", "app", "main.js"))) {
      throw new Error("Build first: npm run build (npm run install-quick-action does this for you).");
    }
    await mkdir(SERVICES_DIR, { recursive: true });
    await writeWorkflow(WORKFLOW_PATH, launcherScript(REPO));
    refreshServices();
    console.log(`Installed “${MENU_TITLE}”.`);
    console.log("In Finder, right-click a file → Quick Actions → " + MENU_TITLE + ".");
    console.log("If it isn't listed, switch it on: System Settings → General → Login Items & Extensions → Extensions → Finder (ⓘ).");
    console.log("It's also under Services, which can be switched on in Keyboard → Keyboard Shortcuts → Services → Files and Folders.");
  } else if (command === "uninstall") {
    const existed = existsSync(WORKFLOW_PATH);
    await removeWorkflow(WORKFLOW_PATH);
    refreshServices();
    console.log(existed ? `Removed “${MENU_TITLE}”.` : `“${MENU_TITLE}” wasn't installed.`);
  } else {
    throw new Error("usage: quick-action.mjs install|uninstall");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((err) => {
    console.error(String(err.message ?? err));
    process.exit(1);
  });
}
