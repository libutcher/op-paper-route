#!/usr/bin/env node
/**
 * Wraps the packaged app in a disk image for distribution:
 *
 *   npm run dmg   → out/PaperRoute-<version>-<arch>.dmg
 *
 * The image holds PaperRoute.app and a shortcut to /Applications, so
 * installing is a drag. Built with macOS's own tools: `ditto` copies the app
 * (keeping its signature intact) and `hdiutil` makes a compressed image.
 * Run `npm run package` first (`npm run dmg` does).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { arch, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const ARCH = arch() === "arm64" ? "arm64" : "x64";
const APP = join(REPO, "out", `PaperRoute-darwin-${ARCH}`, "PaperRoute.app");
const DMG = join(REPO, "out", `PaperRoute-${version}-${ARCH}.dmg`);

if (!existsSync(APP)) throw new Error(`No packaged app at ${APP}. Run npm run package first.`);
// Refuse to ship an app whose signature has been broken since packaging.
execFileSync("codesign", ["--verify", "--deep", "--strict", APP], { stdio: "inherit" });

const staging = mkdtempSync(join(tmpdir(), "paper-route-dmg-"));
try {
  execFileSync("ditto", [APP, join(staging, "PaperRoute.app")]);
  symlinkSync("/Applications", join(staging, "Applications"));
  rmSync(DMG, { force: true });
  execFileSync("hdiutil", ["create", "-volname", "PaperRoute", "-srcfolder", staging, "-format", "UDZO", "-ov", DMG], {
    stdio: ["ignore", "ignore", "inherit"],
  });
} finally {
  rmSync(staging, { recursive: true, force: true });
}

// Check what we made: it mounts, and the app inside is still validly signed.
const mount = mkdtempSync(join(tmpdir(), "paper-route-dmg-check-"));
try {
  execFileSync("hdiutil", ["attach", DMG, "-nobrowse", "-readonly", "-mountpoint", mount], { stdio: "ignore" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", join(mount, "PaperRoute.app")], { stdio: "inherit" });
  if (!existsSync(join(mount, "Applications"))) throw new Error("The disk image has no Applications shortcut.");
} finally {
  try {
    execFileSync("hdiutil", ["detach", mount, "-quiet"], { stdio: "ignore" });
  } catch {
    // Already detached or never attached; nothing to clean up.
  }
  rmSync(mount, { recursive: true, force: true });
}

const size = execFileSync("du", ["-h", DMG], { encoding: "utf8" }).split("\t")[0];
console.log(`Built ${DMG} (${size}). Checked: it mounts, and the app inside is validly signed.`);
