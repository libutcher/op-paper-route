import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Inbox, firstFile, pathArguments } from "./handoff.js";

describe("pathArguments", () => {
  it("skips the executable and, when unpackaged, the app folder", () => {
    const electron = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
    expect(pathArguments([electron, "/repo", "/Users/me/a.pdf"], { isDefaultApp: true })).toEqual(["/Users/me/a.pdf"]);
    expect(pathArguments([electron, "."], { isDefaultApp: true })).toEqual([]);
    expect(pathArguments(["/Applications/PaperRoute.app/Contents/MacOS/PaperRoute", "/Users/me/a.pdf"], { isDefaultApp: false })).toEqual(
      ["/Users/me/a.pdf"],
    );
  });

  it("drops flags, including ones Chromium adds for a second instance", () => {
    expect(
      pathArguments(["electron", "/repo", "--allow-file-access-from-files", "/a.pdf", "-psn_0_12345", "--original-process-start-time=1", "b.pdf"], {
        isDefaultApp: true,
      }),
    ).toEqual(["/a.pdf", "b.pdf"]);
  });
});

describe("firstFile", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "paper-route-handoff-"));
    await writeFile(join(dir, "a.pdf"), "a");
    await writeFile(join(dir, "b.pdf"), "b");
    await writeFile(join(dir, "with space & quote's.pdf"), "c");
    await mkdir(join(dir, "folder"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the first real file and counts the other files left out", async () => {
    await expect(firstFile([join(dir, "a.pdf"), join(dir, "b.pdf")], "/")).resolves.toEqual({
      path: join(dir, "a.pdf"),
      othersIgnored: 1,
    });
  });

  it("resolves relative paths against the launching process's folder", async () => {
    await expect(firstFile(["a.pdf"], dir)).resolves.toEqual({ path: join(dir, "a.pdf"), othersIgnored: 0 });
  });

  it("skips folders and missing paths, and doesn't count them", async () => {
    await expect(firstFile([join(dir, "folder"), join(dir, "missing.pdf"), join(dir, "b.pdf")], "/")).resolves.toEqual({
      path: join(dir, "b.pdf"),
      othersIgnored: 0,
    });
  });

  it("handles awkward file names", async () => {
    await expect(firstFile([join(dir, "with space & quote's.pdf")], "/")).resolves.toMatchObject({
      path: join(dir, "with space & quote's.pdf"),
    });
  });

  it("returns null when nothing usable was passed", async () => {
    await expect(firstFile([], dir)).resolves.toBeNull();
    await expect(firstFile([join(dir, "folder")], dir)).resolves.toBeNull();
  });
});

describe("Inbox", () => {
  const file = (path: string) => ({ path, othersIgnored: 0 });

  it("holds a file that arrives before the window is ready, and hands it over once", () => {
    const send = vi.fn();
    const inbox = new Inbox(send);
    inbox.deliver(file("/early.pdf"));

    expect(send).not.toHaveBeenCalled();
    expect(inbox.take()).toEqual(file("/early.pdf"));
    expect(inbox.take()).toBeNull();
  });

  it("keeps only the latest file while waiting", () => {
    const inbox = new Inbox(vi.fn());
    inbox.deliver(file("/one.pdf"));
    inbox.deliver(file("/two.pdf"));
    expect(inbox.take()).toEqual(file("/two.pdf"));
  });

  it("sends straight to the window once it's ready", () => {
    const send = vi.fn();
    const inbox = new Inbox(send);
    expect(inbox.take()).toBeNull();

    inbox.deliver(file("/later.pdf"));
    expect(send).toHaveBeenCalledWith(file("/later.pdf"));
  });

  it("holds files again after a reset (page reloading), until the window asks", () => {
    const send = vi.fn();
    const inbox = new Inbox(send);
    inbox.take();
    inbox.reset();

    inbox.deliver(file("/during-reload.pdf"));
    expect(send).not.toHaveBeenCalled();
    expect(inbox.take()).toEqual(file("/during-reload.pdf"));
  });
});
