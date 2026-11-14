/**
 * Files handed to PaperRoute from outside the window: a Finder Quick Action
 * or another launch with a path, a drop on the menu-bar icon, or macOS's
 * "open with" event. No Electron imports, so it can be tested.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { IncomingFile } from "../shared/api.js";

/**
 * The arguments in a command line that could be file paths.
 *
 * argv[0] is the executable. When running unpackaged (`electron <app>`,
 * process.defaultApp), argv[1] is the app's own folder, so it's skipped too.
 * Anything starting with "-" is a flag; Chromium adds some of its own to the
 * command line it hands a running instance.
 */
export function pathArguments(argv: readonly string[], { isDefaultApp }: { isDefaultApp: boolean }): string[] {
  return argv.slice(isDefaultApp ? 2 : 1).filter((arg) => arg !== "" && !arg.startsWith("-"));
}

/**
 * The first candidate that is an existing regular file, resolved against
 * `cwd`, plus how many other files were passed and are being left out (one
 * file is saved at a time). Folders and missing paths are dropped silently:
 * they can't be saved, and Finder can pass a folder to a Quick Action.
 */
export async function firstFile(candidates: readonly string[], cwd: string): Promise<IncomingFile | null> {
  // Checked in parallel: a large Finder selection, perhaps on a network
  // share, shouldn't hold the window up for one round-trip per file.
  const checked = await Promise.all(
    candidates.map(async (candidate) => {
      const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
      try {
        return (await stat(path)).isFile() ? path : null;
      } catch {
        return null; // Missing or unreadable: not something we can save.
      }
    }),
  );
  // Promise.all keeps the order, so "first" is still the first one selected.
  const [first, ...rest] = checked.filter((path): path is string => path !== null);
  return first ? { path: first, othersIgnored: rest.length } : null;
}

/**
 * Holds a handed-off file until the window can take it.
 *
 * A file can arrive before the page has loaded (a Quick Action that starts
 * the app). The window asks for anything pending once it's ready; after that,
 * files are sent straight to it. Only the latest file is kept: the window
 * shows one file at a time.
 */
export class Inbox {
  readonly #send: (file: IncomingFile) => void;
  #pending: IncomingFile | null = null;
  #ready = false;

  constructor(send: (file: IncomingFile) => void) {
    this.#send = send;
  }

  deliver(file: IncomingFile): void {
    if (this.#ready) this.#send(file);
    else this.#pending = file;
  }

  /** Called when the window is ready: returns anything that arrived before, and switches to sending directly. */
  take(): IncomingFile | null {
    this.#ready = true;
    const pending = this.#pending;
    this.#pending = null;
    return pending;
  }

  /** The window is gone or reloading: hold files again until it asks. */
  reset(): void {
    this.#ready = false;
  }
}
