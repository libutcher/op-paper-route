#!/usr/bin/env node
/**
 * Builds PaperRoute.app for this Mac's architecture and signs it.
 *
 *   npm run package        → out/PaperRoute-darwin-<arch>/PaperRoute.app
 *
 * Signing is ad hoc (no Developer ID yet): the app runs on this Mac, and on
 * other Macs only after the user allows it under System Settings → Privacy &
 * Security. It's signed with the hardened runtime and the entitlements in
 * build/entitlements.plist, which is what a Developer ID signature will need
 * too, so a later notarised build changes only the signing identity.
 *
 * The app's executable is named PaperRoute, which is the name 1Password shows
 * in its approval prompt (it names the program asking, not the integration).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import packager from "@electron/packager";
import { FuseV1Options, FuseVersion, flipFuses } from "@electron/fuses";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
export const BUNDLE_ID = "io.github.libutcher.paperroute";
const ENTITLEMENTS = join(REPO, "build", "entitlements.plist");
const ICON = join(REPO, "build", "PaperRoute.icns");

if (!existsSync(join(REPO, "dist", "app", "main.js"))) {
  throw new Error("Build first: npm run build (npm run package does this for you).");
}

// Only what the app needs at run time goes into the package.
const KEEP = [/^\/package\.json$/, /^\/dist(\/|$)/, /^\/assets(\/|$)/, /^\/node_modules(\/|$)/];
// Tool leftovers under node_modules (Vitest's caches, .bin links) that the app
// never runs. npm's node_modules/.package-lock.json must stay: the packager's
// pruning of dev dependencies relies on it, and without it they all get in.
const DROP = [/^\/node_modules\/\.(vite|vite-temp|cache|bin)(\/|$)/];
const ignore = (path) => path !== "" && (!KEEP.some((keep) => keep.test(path)) || DROP.some((drop) => drop.test(path)));

const [appDir] = await packager({
  dir: REPO,
  out: join(REPO, "out"),
  overwrite: true,
  platform: "darwin",
  arch: arch() === "arm64" ? "arm64" : "x64",
  name: "PaperRoute",
  executableName: "PaperRoute",
  appBundleId: BUNDLE_ID,
  appVersion: pkg.version,
  appCategoryType: "public.app-category.productivity",
  ...(existsSync(ICON) ? { icon: ICON } : {}),
  asar: true,
  prune: true, // dev dependencies (TypeScript, Vitest, Electron itself) stay out
  ignore,
  // A menu-bar app: no Dock icon, even for the moment before the app hides it.
  extendInfo: { LSUIElement: true, NSHumanReadableCopyright: "" },
  // Signed below, so the hardened runtime and entitlements are exactly ours.
  osxSign: false,
});

const app = join(appDir, "PaperRoute.app");

// Fuses are switches compiled into the Electron binary. Flipped here, before
// signing, so the shipped app can't be repurposed: without these, anyone (or
// any malware) could run arbitrary code *as PaperRoute* by setting an
// environment variable or a command-line flag, and that code would inherit
// whatever the user had granted PaperRoute.
await flipFuses(join(app, "Contents", "MacOS", "PaperRoute"), {
  version: FuseVersion.V1,
  // ELECTRON_RUN_AS_NODE: run as plain Node instead of as PaperRoute.
  [FuseV1Options.RunAsNode]: false,
  // NODE_OPTIONS: e.g. --require some-script.js before the app's own code.
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  // --inspect and friends: attach a debugger to the main process.
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // Load the app only from app.asar, and refuse an app.asar whose hash doesn't
  // match the one recorded in Info.plist (the packager records it).
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  // Encrypt cookies on disk. PaperRoute stores none, but it costs nothing.
  [FuseV1Options.EnableCookieEncryption]: true,
  // GrantFileProtocolExtraPrivileges is left at its default (on): the window
  // is a file:// page that loads ES modules, which relies on it.
});

const sign = (...args) => execFileSync("codesign", args, { stdio: "inherit" });

// --deep signs every helper and framework inside with the same ad hoc
// identity and entitlements. Fine for ad hoc; a Developer ID build should
// sign inside-out instead.
sign("--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", ENTITLEMENTS, "--timestamp=none", app);
sign("--verify", "--deep", "--strict", app);

const details = execFileSync("codesign", ["-dv", "--entitlements", ":-", app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
console.log(`\nBuilt and signed (ad hoc, hardened runtime): ${app}`);
void details;
