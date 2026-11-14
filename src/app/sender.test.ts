import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isOurPage } from "./sender.js";

const INDEX = "/Applications/PaperRoute.app/Contents/Resources/app/dist/renderer/index.html";

describe("isOurPage", () => {
  it("accepts the page's own file URL", () => {
    expect(isOurPage(pathToFileURL(INDEX).href, INDEX)).toBe(true);
  });

  it("accepts the same file however the URL is percent-encoded", () => {
    const tricky = "/Users/me/100% real/it's [here] #1/café/index.html";
    // Node's encoding, a fully encoded form, and a minimally encoded form.
    const full = "file://" + tricky.split("/").map(encodeURIComponent).join("/");
    const minimal = "file://" + tricky.replaceAll("%", "%25").replaceAll("#", "%23").replaceAll(" ", "%20");
    // The forms really do differ as text, which is what broke exact comparison.
    expect(minimal).not.toBe(pathToFileURL(tricky).href);
    for (const url of [pathToFileURL(tricky).href, full, minimal]) {
      expect(isOurPage(url, tricky), url).toBe(true);
    }
  });

  it("ignores a query string or hash", () => {
    expect(isOurPage(`${pathToFileURL(INDEX).href}?x=1#top`, INDEX)).toBe(true);
  });

  it("rejects other files, other schemes, and junk", () => {
    const other = INDEX.replace("index.html", "other.html");
    for (const url of [
      pathToFileURL(other).href,
      pathToFileURL(`${INDEX}/../evil.html`).href,
      "https://example.com/index.html",
      `https://example.com${INDEX}`,
      "about:blank",
      "not a url",
      "",
      undefined,
    ]) {
      expect(isOurPage(url, INDEX), String(url)).toBe(false);
    }
  });
});
