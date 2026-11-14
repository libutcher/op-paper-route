#!/usr/bin/env node
/**
 * Installs or removes the Finder Quick Action for a development copy of
 * PaperRoute (one run from this folder with Electron).
 *
 *   npm run install-quick-action     (builds the app first)
 *   npm run uninstall-quick-action
 *
 * The packaged app installs its own Quick Action from its menu-bar menu,
 * pointing at the installed app instead of this folder. The workflow
 * generator lives in src/app/quick-action.ts; this script uses the built copy.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILT = join(REPO, "dist", "app", "quick-action.js");

if (process.platform !== "darwin") throw new Error("Quick Actions are macOS only.");
if (!existsSync(BUILT) || !existsSync(join(REPO, "dist", "app", "main.js"))) {
  console.error("Build first: npm run build (npm run install-quick-action does this for you).");
  process.exit(1);
}

const qa = await import(BUILT);
const command = process.argv[2];

if (command === "install") {
  await qa.installQuickAction(qa.developmentLauncherScript(REPO));
  console.log(`Installed “${qa.MENU_TITLE}” for this development copy.`);
  console.log(`In Finder, right-click a file → Quick Actions → ${qa.MENU_TITLE}.`);
  console.log(qa.ENABLE_HINT);
} else if (command === "uninstall") {
  const existed = qa.isInstalled();
  await qa.uninstallQuickAction();
  console.log(existed ? `Removed “${qa.MENU_TITLE}”.` : `“${qa.MENU_TITLE}” wasn't installed.`);
} else {
  console.error("usage: quick-action.mjs install|uninstall");
  process.exit(1);
}
