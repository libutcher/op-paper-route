import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUNDLE_ID,
  MENU_TITLE,
  developmentLauncherScript,
  packagedLauncherScript,
  quickActionState,
  removeWorkflow,
  shellQuote,
  writeWorkflow,
} from "./quick-action.js";

const onMac = process.platform === "darwin";
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "paper-route-qa-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("shellQuote", () => {
  it("round-trips awkward strings through a real shell", () => {
    for (const value of [`it's`, `"quoted"`, "$HOME", "`cmd`", "a & b; c", "", "x'y'z"]) {
      const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`]).toString();
      expect(out, value).toBe(value);
    }
  });
});

describe("developmentLauncherScript", () => {
  it("is valid shell and recovers the folder path exactly", async () => {
    const repo = `/tmp/it's a "test" $HOME \`x\` & more`;
    const script = developmentLauncherScript(repo);
    const file = join(dir, "launcher.zsh");
    await writeFile(file, script);
    execFileSync("zsh", ["-n", file]);

    const repoLine = script.split("\n").find((line) => line.startsWith("REPO="));
    expect(execFileSync("zsh", ["-c", `${repoLine}; printf %s "$REPO"`]).toString()).toBe(repo);
  });

  it("clears ELECTRON_RUN_AS_NODE and runs in the background", () => {
    const script = developmentLauncherScript("/repo");
    expect(script).toContain("unset ELECTRON_RUN_AS_NODE");
    expect(script).toMatch(/nohup "\$ELECTRON" "\$REPO" "\$@" .*&\n$/);
  });
});

describe("packagedLauncherScript", () => {
  it("is valid shell and opens the files with the app by bundle id, wherever it's installed", async () => {
    const script = packagedLauncherScript();
    const file = join(dir, "packaged.zsh");
    await writeFile(file, script);
    execFileSync("zsh", ["-n", file]);

    expect(script).toContain(`open -b '${BUNDLE_ID}' "$@"`);
    expect(script).not.toMatch(/\/Applications|\.app\b|ELECTRON/);
  });

  it("quotes the bundle id for the shell", () => {
    expect(packagedLauncherScript("x'; rm -rf ~; '")).toContain(`open -b 'x'\\''; rm -rf ~; '\\''' "$@"`);
  });
});

describe.skipIf(!onMac)("writeWorkflow", () => {
  it("writes valid plists for a Finder service that passes files as arguments", async () => {
    const bundle = join(dir, "Test.workflow");
    await writeWorkflow(bundle, "true");
    const info = join(bundle, "Contents", "Info.plist");
    const doc = join(bundle, "Contents", "document.wflow");
    execFileSync("plutil", ["-lint", "-s", info, doc]);

    const read = (path: string, key: string) => execFileSync("plutil", ["-extract", key, "raw", "-o", "-", path]).toString().trim();
    expect(read(info, "NSServices.0.NSMenuItem.default")).toBe(MENU_TITLE);
    expect(read(info, "NSServices.0.NSRequiredContext.NSApplicationIdentifier")).toBe("com.apple.finder");
    // Without an icon, Finder lists it under Services instead of Quick Actions.
    expect(read(info, "NSServices.0.NSIconName")).toBe("NSActionTemplate");
    expect(read(doc, "actions.0.action.ActionParameters.inputMethod")).toBe("1");
    expect(read(doc, "workflowMetaData.serviceInputTypeIdentifier")).toBe("com.apple.Automator.fileSystemObject");
  });

  it("is run by Automator with the file path as an argument", async () => {
    const bundle = join(dir, "Probe.workflow");
    const log = join(dir, "args.log");
    await writeFile(log, "");
    await writeWorkflow(bundle, `for f in "$@"; do print -r -- "$f" >> ${shellQuote(log)}; done`);
    const input = join(dir, "sample receipt's.pdf");
    await writeFile(input, "pdf");

    execFileSync("automator", ["-i", input, bundle], { stdio: "pipe", timeout: 30_000 });
    expect(await readFile(log, "utf8")).toBe(`${input}\n`);
  }, 40_000);

  it("keeps the installed workflow when building the new one fails", async () => {
    const bundle = join(dir, "Keep.workflow");
    await writeWorkflow(bundle, "echo working");
    const doc = join(bundle, "Contents", "document.wflow");
    const command = () => execFileSync("plutil", ["-extract", "actions.0.action.ActionParameters.COMMAND_STRING", "raw", "-o", "-", doc]).toString().trim();
    expect(command()).toBe("echo working");

    // A BigInt can't be turned into JSON, so writing the new plist throws.
    await expect(writeWorkflow(bundle, 1n as unknown as string)).rejects.toThrow();

    expect(command()).toBe("echo working");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(dir)).filter((name) => name.includes(".staging-"))).toEqual([]);
  });

  it("replaces an existing workflow cleanly", async () => {
    const bundle = join(dir, "Replace.workflow");
    await writeWorkflow(bundle, "echo one");
    await writeFile(join(bundle, "Contents", "stale.txt"), "old");
    await writeWorkflow(bundle, "echo two");
    expect(existsSync(join(bundle, "Contents", "stale.txt"))).toBe(false);
  });
});

describe.skipIf(!onMac)("quickActionState", () => {
  it("tells the packaged app's Quick Action apart from a development copy's", async () => {
    const ours = join(dir, "Ours.workflow");
    const other = join(dir, "Other.workflow");
    await writeWorkflow(ours, packagedLauncherScript());
    await writeWorkflow(other, developmentLauncherScript("/some/repo"));

    expect(quickActionState(ours)).toBe("ours");
    expect(quickActionState(other)).toBe("other");
    expect(quickActionState(join(dir, "Missing.workflow"))).toBe("none");
    // A different app's bundle id doesn't count as ours.
    expect(quickActionState(ours, "com.example.other")).toBe("other");
  });
});

describe("removeWorkflow", () => {
  it("refuses anything that isn't a .workflow bundle", async () => {
    for (const path of [dir, join(dir, "Library"), "/", join(dir, ".workflow")]) {
      await expect(removeWorkflow(path), path).rejects.toThrow(/Refusing/);
    }
    expect(existsSync(dir)).toBe(true);
  });

  it("removes a workflow, and is fine if it's already gone", async () => {
    const bundle = join(dir, "Gone.workflow");
    if (onMac) await writeWorkflow(bundle, "true");
    await removeWorkflow(bundle);
    expect(existsSync(bundle)).toBe(false);
    await expect(removeWorkflow(bundle)).resolves.toBeUndefined();
  });
});
