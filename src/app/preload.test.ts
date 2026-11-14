import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "../shared/api.js";

describe("preload", () => {
  it("uses exactly the channel names the main process listens on", async () => {
    // The sandboxed preload can't import CHANNELS, so it repeats them.
    const source = await readFile(new URL("./preload.cts", import.meta.url), "utf8");
    const block = source.match(/const CH = \{([\s\S]*?)\};/)?.[1] ?? "";
    const declared = Object.fromEntries([...block.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
    expect(declared).toEqual(CHANNELS);
  });
});
