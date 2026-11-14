// Renders preview images of PaperRoute:
//
//   npm run social-preview               → docs/social-preview.png, 1280×640, the
//                                          repo's link preview on GitHub
//   electron scripts/social/preview.cjs square
//                                        → out/paperroute-square.png, 1200×1200, for
//                                          a portfolio or LinkedIn Projects section
//
// The window in the image is the real app page (dist/renderer), driven to
// "just saved" by the demo's stand-in backend, so nothing personal appears.
// It's then placed on a composed card beside the icon, name and tagline.

const { app, BrowserWindow, nativeImage, nativeTheme } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..", "..");
const PAGE = path.join(REPO, "dist", "renderer", "index.html");
const SQUARE = process.argv.includes("square");
const OUT = SQUARE ? path.join(REPO, "out", "paperroute-square.png") : path.join(REPO, "docs", "social-preview.png");
const WIDTH = SQUARE ? 1200 : 1280;
const HEIGHT = SQUARE ? 1200 : 640;

// What the window shows. The square version uses a neutral example and no
// Trash option, so the saved message is short.
const SCENE = SQUARE
  ? { file: "/Users/demo/Documents/Lease agreement.pdf", retitle: null, vaultId: "v-personal", trash: false }
  : { file: "/Users/demo/Downloads/Dentist receipt.pdf", retitle: "Dentist visit, March", vaultId: null, trash: true };

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function key(win, keyCode) {
  for (const type of ["keyDown", "char", "keyUp"]) win.webContents.sendInputEvent({ type, keyCode });
}

async function type(win, text) {
  for (const ch of text) {
    key(win, ch);
    await wait(15);
  }
}

/**
 * The real window, dark, with a document just saved. Returns the window (reused
 * for the card: a second window in one run fails to load its page) and a PNG
 * data URL of it.
 */
async function renderWindow() {
  const win = new BrowserWindow({
    width: 440,
    height: 476,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    webPreferences: { preload: path.join(REPO, "scripts", "demo", "preload.cjs"), sandbox: true, contextIsolation: true },
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on("dom-ready", () => {
    void win.webContents.insertCSS(`
      html { background: transparent !important; }
      body { border-radius: 12px; overflow: hidden; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12); }
      /* A still image: show the end state of each animation. */
      *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }
    `);
  });
  const painted = new Promise((resolve) => win.once("ready-to-show", resolve));
  await win.loadFile(PAGE);
  await painted;
  win.show(); // shown so the page renders normally; it's off-screen work for a second or two
  await wait(3800); // the stand-in backend "connects" and lists vaults
  win.webContents.send("demo:incoming", { path: SCENE.file, othersIgnored: 0 });
  await wait(400);
  if (SCENE.retitle) await type(win, SCENE.retitle);
  if (SCENE.vaultId) {
    await win.webContents.executeJavaScript(
      `(() => { const v = document.getElementById("vault"); v.value = ${JSON.stringify(SCENE.vaultId)}; v.dispatchEvent(new Event("change")); document.getElementById("title").focus(); })()`,
    );
  }
  if (SCENE.trash) await win.webContents.executeJavaScript(`document.getElementById("trash-after-save").click(); true`);
  await wait(200);
  key(win, "Return");
  await wait(1900); // "Saving…", then the saved message
  // In a still, a focus ring just looks like a stray selection.
  await win.webContents.executeJavaScript(`document.activeElement?.blur(); true`);
  await wait(100);
  const image = await win.webContents.capturePage();
  return { win, png: image.toDataURL() };
}

function card(windowPng, iconSvg) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
      color: #f2f2f2;
      background:
        radial-gradient(900px 520px at 78% 55%, rgba(58, 116, 196, 0.38), transparent 70%),
        radial-gradient(700px 500px at 0% 0%, rgba(31, 78, 140, 0.35), transparent 70%),
        #121418;
      display: flex; align-items: center; padding: 0 72px; gap: 64px;
    }
    .text { flex: 1; min-width: 0; }
    .icon { width: 132px; height: 132px; margin: 0 0 22px -14px; display: block; }
    h1 { font-size: 76px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
    .tagline { margin-top: 20px; font-size: 32px; line-height: 1.3; color: #d6deea; font-weight: 500; }
    .meta { margin-top: 28px; display: flex; gap: 10px; flex-wrap: wrap; }
    .pill { font-size: 19px; padding: 7px 14px; border-radius: 999px; background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.14); color: #c3ccd9; }
    .shot { width: 440px; flex-shrink: 0; filter: drop-shadow(0 30px 50px rgba(0,0,0,0.55)) drop-shadow(0 4px 10px rgba(0,0,0,0.4)); }
    .shot img { width: 440px; display: block; }
  </style></head><body>
    <div class="text">
      <img class="icon" src="data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}" alt="">
      <h1>PaperRoute</h1>
      <p class="tagline">Save documents to 1Password<br>in one drop.</p>
      <div class="meta"><span class="pill">macOS menu-bar app</span><span class="pill">Touch ID approval</span><span class="pill">v0.1 · early</span></div>
    </div>
    <div class="shot"><img src="${windowPng}" alt=""></div>
  </body></html>`;
}

process.on("unhandledRejection", (err) => {
  console.error("social preview failed:", err);
  app.exit(1);
});

function squareCard(windowPng, iconSvg) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    html, body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
      color: #f2f2f2;
      background:
        radial-gradient(900px 700px at 50% 78%, rgba(58, 116, 196, 0.40), transparent 70%),
        radial-gradient(800px 600px at 0% 0%, rgba(31, 78, 140, 0.30), transparent 70%),
        #121418;
      display: flex; flex-direction: column; align-items: center; padding-top: 92px;
    }
    .head { display: flex; align-items: center; gap: 28px; }
    .icon { width: 128px; height: 128px; display: block; margin-left: -12px; }
    h1 { font-size: 84px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; }
    .tagline { margin-top: 30px; font-size: 34px; line-height: 1.3; color: #d6deea; font-weight: 500; text-align: center; }
    .meta { margin-top: 26px; display: flex; gap: 12px; }
    .pill { font-size: 21px; padding: 8px 16px; border-radius: 999px; background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.14); color: #c3ccd9; }
    .shot { margin-top: 60px; filter: drop-shadow(0 30px 50px rgba(0,0,0,0.55)) drop-shadow(0 4px 10px rgba(0,0,0,0.4)); }
    .shot img { width: 520px; display: block; }
  </style></head><body>
    <div class="head">
      <img class="icon" src="data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}" alt="">
      <h1>PaperRoute</h1>
    </div>
    <p class="tagline">A macOS menu-bar app for filing<br>documents into 1Password.</p>
    <div class="meta"><span class="pill">TypeScript</span><span class="pill">Electron</span><span class="pill">1Password SDK</span></div>
    <div class="shot"><img src="${windowPng}" alt=""></div>
  </body></html>`;
}

app.whenReady().then(async () => {
  setTimeout(() => {
    console.error("social preview timed out");
    app.exit(1);
  }, 60000);
  app.dock?.hide();
  nativeTheme.themeSource = "dark";
  const { win, png: windowPng } = await renderWindow();
  const iconSvg = fs.readFileSync(path.join(REPO, "assets", "app-icon.svg"), "utf8").replace(/<!--[\s\S]*?-->/g, "");

  const page = path.join(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "paper-route-social-")), "card.html");
  fs.writeFileSync(page, (SQUARE ? squareCard : card)(windowPng, iconSvg));
  // Lay the card out at full size but show it at half scale, so the window
  // fits on any screen (macOS caps a window at the screen's height, which
  // squashed the square version) and a Retina capture comes out at exactly
  // WIDTH×HEIGHT pixels.
  // The rounded-window styling was for the app page only; the card is a plain rectangle.
  win.webContents.removeAllListeners("dom-ready");
  win.setContentSize(WIDTH / 2, HEIGHT / 2);
  await win.loadFile(page);
  win.webContents.setZoomFactor(0.5);
  await wait(500);
  const shot = await win.webContents.capturePage();
  const got = shot.getSize();
  if (Math.abs(got.width / got.height - WIDTH / HEIGHT) > 0.01) {
    throw new Error(`capture is ${got.width}×${got.height}, not ${WIDTH}:${HEIGHT}; refusing to stretch it`);
  }
  const out = got.width === WIDTH ? shot : shot.resize({ width: WIDTH, height: HEIGHT, quality: "best" });
  if (got.width < WIDTH) console.warn(`note: captured at ${got.width}px and scaled up; render on a Retina display for full sharpness`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out.toPNG());
  fs.rmSync(path.dirname(page), { recursive: true, force: true });
  const { width, height } = nativeImage.createFromPath(OUT).getSize();
  console.log(`Wrote ${path.relative(REPO, OUT)} (${width}×${height}, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
  app.quit();
});
