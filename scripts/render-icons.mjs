#!/usr/bin/env node
/**
 * Renders the icons from their SVG sources:
 *
 *   assets/tray-icon.svg → assets/trayTemplate.png     18×18 menu-bar icon
 *                          assets/trayTemplate@2x.png  36×36 (Retina)
 *   assets/app-icon.svg  → build/PaperRoute.icns       the app's icon, 16–1024px
 *
 *   npm run render-icons
 *
 * Uses macOS's own `sips`, which reads SVG and keeps transparency, and
 * `iconutil` for the .icns. Every size is rendered from the SVG, not scaled
 * from another PNG, so small sizes stay sharp. The outputs are committed, so
 * building the app doesn't need this.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(REPO, "assets");

function renderPng(svg, size, out) {
  execFileSync("sips", ["-s", "format", "png", "-z", String(size), String(size), svg, "--out", out], { stdio: "ignore" });
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", out]).toString();
  if (!info.includes(`pixelWidth: ${size}`) || !info.includes("hasAlpha: yes")) {
    throw new Error(`${out} didn't come out as a ${size}×${size} transparent PNG:\n${info}`);
  }
}

// Menu bar.
for (const [size, file] of [
  [18, "trayTemplate.png"],
  [36, "trayTemplate@2x.png"],
]) {
  renderPng(join(ASSETS, "tray-icon.svg"), size, join(ASSETS, file));
  console.log(`wrote assets/${file} (${size}×${size})`);
}

// App icon: an .iconset folder with the sizes macOS expects, then iconutil.
const scratch = mkdtempSync(join(tmpdir(), "paper-route-iconset-"));
try {
  const iconset = join(scratch, "PaperRoute.iconset");
  execFileSync("mkdir", [iconset]);
  for (const points of [16, 32, 128, 256, 512]) {
    renderPng(join(ASSETS, "app-icon.svg"), points, join(iconset, `icon_${points}x${points}.png`));
    renderPng(join(ASSETS, "app-icon.svg"), points * 2, join(iconset, `icon_${points}x${points}@2x.png`));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(REPO, "build", "PaperRoute.icns")]);
  console.log("wrote build/PaperRoute.icns (16–1024px)");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
