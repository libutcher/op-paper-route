import { fileURLToPath } from "node:url";

/**
 * True when `url` is a file: URL for exactly the file at `indexHtml`.
 *
 * The comparison is on decoded filesystem paths, not URL text. Electron's
 * loadFile() and Node's pathToFileURL() don't always percent-encode a path
 * the same way, so comparing URL strings can reject the app's own page when
 * its install path contains unusual characters.
 */
export function isOurPage(url: string | undefined, indexHtml: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return false;
    // Ignore any ?query or #hash; only the file itself identifies the page.
    parsed.search = "";
    parsed.hash = "";
    return fileURLToPath(parsed) === indexHtml;
  } catch {
    return false;
  }
}
