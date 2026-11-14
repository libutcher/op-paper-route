#!/usr/bin/env node
/**
 * Renders assets/tray-icon.svg to the PNGs the menu bar uses:
 *   assets/trayTemplate.png     18×18  (standard displays)
 *   assets/trayTemplate@2x.png  36×36  (Retina; Electron picks it automatically)
 *
 *   npm run render-icons
 *
 * Uses macOS's own `sips`, which reads SVG and keeps transparency. The PNGs
 * are committed, so building the app doesn't need this.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const SVG = join(ASSETS, "tray-icon.svg");

for (const [size, file] of [
  [18, "trayTemplate.png"],
  [36, "trayTemplate@2x.png"],
]) {
  execFileSync("sips", ["-s", "format", "png", "-z", String(size), String(size), SVG, "--out", join(ASSETS, file)], {
    stdio: "ignore",
  });
  const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", join(ASSETS, file)]).toString();
  if (!info.includes(`pixelWidth: ${size}`) || !info.includes("hasAlpha: yes")) {
    throw new Error(`assets/${file} didn't come out as a ${size}×${size} transparent PNG:\n${info}`);
  }
  console.log(`wrote assets/${file} (${size}×${size})`);
}
