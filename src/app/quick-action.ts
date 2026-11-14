/**
 * The Finder Quick Action "Save to 1Password with PaperRoute".
 *
 * It's an Automator workflow in ~/Library/Services whose one step runs a
 * shell script with the selected files. Installed from the app's menu (for a
 * packaged app) or with `npm run install-quick-action` (when developing).
 *
 * Automator's file format isn't documented. This mirrors the "Run Shell
 * Script" action in macOS's own /System/Library/Services/Show Map.workflow.
 * The plists are written as JSON and converted with plutil, so nothing is
 * hand-escaped into XML. No Electron imports, so it can be tested.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const MENU_TITLE = "Save to 1Password with PaperRoute";
export const SERVICES_DIR = join(homedir(), "Library", "Services");
export const WORKFLOW_PATH = join(SERVICES_DIR, `${MENU_TITLE}.workflow`);
/** The packaged app's bundle identifier (scripts/package.mjs uses this too). */
export const BUNDLE_ID = "io.github.libutcher.paperroute";

/** Quote a string for a POSIX shell: wrap in single quotes, and end/escape/reopen around any single quote. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * For the packaged app: ask macOS to open the files with the app that has
 * this bundle identifier, wherever it's installed. The app receives them as
 * "open file" events, starting first if it isn't running.
 */
export function packagedLauncherScript(bundleId: string = BUNDLE_ID): string {
  return `# PaperRoute Quick Action: hand the selected files to PaperRoute.
# Installed from PaperRoute's menu; reinstall from there rather than editing.
if ! open -b ${shellQuote(bundleId)} "$@" 2>/dev/null; then
  osascript -e 'display alert "PaperRoute isn’t installed" message "Install PaperRoute in Applications, open it, and choose Install Finder Quick Action from its menu."' >/dev/null 2>&1
  exit 1
fi
`;
}

/** For development: run PaperRoute from a source folder with the files as arguments. */
export function developmentLauncherScript(repoDir: string): string {
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
export function infoPlist(): Record<string, unknown> {
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
export function documentWflow(command: string): Record<string, unknown> {
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
async function writePlist(path: string, value: unknown): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "paper-route-plist-"));
  try {
    const json = join(scratch, "in.json");
    await writeFile(json, JSON.stringify(value));
    await run("plutil", ["-convert", "xml1", "-o", path, json]);
    await run("plutil", ["-lint", "-s", path]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Build the workflow bundle at `bundlePath` with the given shell script,
 * replacing any old one. The new bundle is built and checked beside the old
 * one and only swapped in once it's complete, so a failed install leaves the
 * existing Quick Action working.
 */
export async function writeWorkflow(bundlePath: string, command: string): Promise<void> {
  if (!bundlePath.endsWith(".workflow")) throw new Error(`Refusing to write a workflow to ${bundlePath}`);
  // Not a .workflow name, so macOS never picks up a half-built bundle as a service.
  const staging = `${bundlePath}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  try {
    const contents = join(staging, "Contents");
    await mkdir(contents, { recursive: true });
    await writePlist(join(contents, "Info.plist"), infoPlist());
    await writePlist(join(contents, "document.wflow"), documentWflow(command));
    await removeWorkflow(bundlePath);
    await rename(staging, bundlePath);
  } catch (err) {
    await rm(staging, { recursive: true, force: true });
    throw err;
  }
}

/** Remove the workflow bundle at `bundlePath`, if it's there. Only ever a *.workflow bundle. */
export async function removeWorkflow(bundlePath: string): Promise<void> {
  if (!bundlePath.endsWith(".workflow") || basename(bundlePath) === ".workflow") {
    throw new Error(`Refusing to remove ${bundlePath}: not a .workflow bundle`);
  }
  await rm(bundlePath, { recursive: true, force: true });
}

/** Ask macOS to re-read the Services folder, so the menu updates without logging out. */
export async function refreshServices(): Promise<void> {
  try {
    await run("/System/Library/CoreServices/pbs", ["-update"]);
  } catch {
    // Not fatal: Finder picks the change up on its own, if more slowly.
  }
}

export function isInstalled(bundlePath: string = WORKFLOW_PATH): boolean {
  return existsSync(bundlePath);
}

/**
 * Whether the installed Quick Action is this packaged app's (opens it by
 * bundle id), someone else's (e.g. a development copy's, which runs a source
 * folder), or not installed at all. Decides what the app's menu offers.
 */
export function quickActionState(bundlePath: string = WORKFLOW_PATH, bundleId: string = BUNDLE_ID): "none" | "ours" | "other" {
  if (!existsSync(bundlePath)) return "none";
  try {
    const doc = readFileSync(join(bundlePath, "Contents", "document.wflow"), "utf8");
    return doc.includes(`open -b ${shellQuote(bundleId)}`) || doc.includes(`open -b &apos;${bundleId}&apos;`) ? "ours" : "other";
  } catch {
    return "other";
  }
}

/** Install (or reinstall) the Quick Action with the given launcher script. */
export async function installQuickAction(command: string, bundlePath: string = WORKFLOW_PATH): Promise<void> {
  await mkdir(SERVICES_DIR, { recursive: true });
  await writeWorkflow(bundlePath, command);
  await refreshServices();
}

export async function uninstallQuickAction(bundlePath: string = WORKFLOW_PATH): Promise<void> {
  await removeWorkflow(bundlePath);
  await refreshServices();
}

/** Where to switch the Quick Action on if Finder doesn't list it (new ones can start off). */
export const ENABLE_HINT =
  "If it isn't in the Quick Actions menu, switch it on in System Settings → General → Login Items & Extensions → Extensions → Finder.";
