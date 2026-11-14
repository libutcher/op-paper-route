// Records an animated demo of the real app window.
//
//   npm run demo          → docs/demo-dark.gif
//
// Loads the built window (dist/renderer/index.html) with a stand-in backend
// (preload.cjs) in dark mode, acts out a save, captures frames throughout,
// and assembles them into a GIF with ImageMagick (`magick`, from Homebrew)
// using each frame's real timing. The window is shown while recording,
// because a hidden window stops running CSS animations.
//
//   electron scripts/demo/record.cjs [light|dark] [out.gif]

const { app, BrowserWindow, nativeImage, nativeTheme } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");
const PAGE = path.join(REPO, "dist", "renderer", "index.html");
const theme = process.argv.includes("light") ? "light" : "dark";
const OUT = process.argv.find((a) => a.endsWith(".gif")) ?? path.join(REPO, "docs", `demo-${theme}.gif`);
const SCALE = 0.75; // of Retina size: crisp, but not huge
const CORNER_RADIUS = 12; // macOS window corners

const FILE = { path: "/Users/demo/Downloads/Dentist receipt.pdf", othersIgnored: 0 };
const NEW_TITLE = "Dentist visit, March";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Type text as real key events, so the page's selection behaviour is what gets recorded. */
async function type(win, text, perChar = 70) {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: ch });
    win.webContents.sendInputEvent({ type: "char", keyCode: ch });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: ch });
    await wait(perChar);
  }
}

function press(win, key) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
  win.webContents.sendInputEvent({ type: "char", keyCode: key });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
}

/** Click the centre of an element, as real mouse events. */
async function click(win, selector) {
  const { x, y } = await win.webContents.executeJavaScript(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
  );
  win.webContents.sendInputEvent({ type: "mouseMove", x, y });
  win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = theme;
  // Frameless and transparent, so the page can round its own corners and the
  // frames keep transparent corners, like a Mac window floating on the README.
  // The size is the real window's content area (its 440×508 includes a title bar).
  const win = new BrowserWindow({
    width: 440,
    height: 476,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    title: "PaperRoute demo",
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), sandbox: true, contextIsolation: true },
  });
  win.webContents.on("console-message", (e) => {
    if (e.level === "error") console.error(`window: ${e.message}`);
  });
  win.webContents.setBackgroundThrottling(false);

  // Frames are captured continuously once the page has drawn (a capture
  // before the first paint never returns) until told to stop. Each capture
  // gets a timeout too, so one stuck capture can't hang the recording.
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-route-demo-"));
  const frames = []; // { file, at }
  let recording = true;
  let started = 0;
  const captureOne = () =>
    Promise.race([win.webContents.capturePage(), wait(2000).then(() => null)]);
  const record = async () => {
    while (recording) {
      const image = await captureOne();
      if (image && !image.isEmpty()) {
        const { width } = image.getSize();
        const file = path.join(framesDir, `f${String(frames.length).padStart(4, "0")}.png`);
        fs.writeFileSync(file, image.resize({ width: Math.round(width * SCALE), quality: "best" }).toPNG());
        frames.push({ file, at: Date.now() - started });
      }
      await wait(40); // ~20 fps
    }
  };

  // ---- The story ----
  const painted = new Promise((resolve) => win.once("ready-to-show", resolve));
  const loaded = win.loadFile(PAGE); // "Connecting to 1Password…", then "Waiting for 1Password", then vaults
  win.webContents.on("dom-ready", () => {
    void win.webContents.insertCSS(`
      html { background: transparent !important; }
      body { border-radius: ${CORNER_RADIUS}px; overflow: hidden;
             box-shadow: inset 0 0 0 1px rgba(128, 128, 128, 0.25); }
    `);
  });
  await painted;
  win.show();
  started = Date.now();
  const capture = record();
  await loaded;
  await wait(4300); // vaults arrive at ~3.2 s; rest on "Ready." briefly
  win.webContents.send("demo:incoming", FILE); // the Quick Action hands a file over
  await wait(1300);
  await type(win, NEW_TITLE); // replaces the selected name part; the extension stays
  await wait(600);
  await click(win, "#trash-after-save");
  await wait(900);
  press(win, "Return"); // save
  await wait(1400 + 2600); // saving, then the result on screen
  recording = false;
  await capture;
  win.hide();

  // ---- Assemble the GIF ----
  // ImageMagick takes a delay (in 1/100 s) before each frame.
  const args = ["-loop", "0"];
  frames.forEach((frame, i) => {
    const next = frames[i + 1]?.at ?? frame.at + 50;
    const delay = Math.max(2, Math.round((next - frame.at) / 10));
    args.push("-delay", String(i === frames.length - 1 ? 250 : delay), frame.file);
  });
  args.push("-layers", "Optimize", OUT);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync("magick", args, { stdio: "inherit" });
  fs.rmSync(framesDir, { recursive: true, force: true });

  const seconds = ((frames.at(-1).at - frames[0].at) / 1000).toFixed(1);
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${path.relative(REPO, OUT)}: ${frames.length} frames over ${seconds}s, ${mb} MB`);
  app.quit();
});
