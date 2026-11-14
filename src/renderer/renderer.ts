/**
 * The PaperRoute window. Runs in a sandboxed page; everything it does goes
 * through `window.paperRoute` (see src/app/preload.cts).
 *
 * The flow is built to be finished without thinking: drop a file, the title
 * is filled in, the last vault is already selected, press Return.
 */

import type { IncomingFile, PaperRouteApi, Result, VaultSummary } from "../shared/api.js";
import {
  ApprovalTracker,
  IncomingQueue,
  describeError,
  fileNameOf,
  isRetryable,
  oneAtATimeNote,
  savedMessage,
  slowCallMessage,
  titleFor,
  vaultOptions,
} from "../shared/window-logic.js";

declare global {
  interface Window {
    paperRoute: PaperRouteApi;
  }
}

const api = window.paperRoute;

/** After this long without an answer, say something so the window doesn't look frozen. */
const PROMPT_HINT_AFTER_MS = 1500;

const approval = new ApprovalTracker();
const incoming = new IncomingQueue();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const accountView = $<HTMLFormElement>("account-view");
const accountInput = $<HTMLInputElement>("account-name");
const accountError = $<HTMLParagraphElement>("account-error");

const saveView = $<HTMLFormElement>("save-view");
const drop = $<HTMLDivElement>("drop");
const dropEmpty = $<HTMLDivElement>("drop-empty");
const dropFile = $<HTMLDivElement>("drop-file");
const fileNameEl = $<HTMLElement>("file-name");
const chooseButton = $<HTMLButtonElement>("choose");
const clearButton = $<HTMLButtonElement>("clear-file");
const titleInput = $<HTMLInputElement>("title");
const vaultSelect = $<HTMLSelectElement>("vault");
const saveButton = $<HTMLButtonElement>("save");
const trashCheckbox = $<HTMLInputElement>("trash-after-save");
const statusEl = $<HTMLDivElement>("status");
const statusActions = $<HTMLDivElement>("status-actions");

let filePath: string | null = null;
/** A call to the main process is in flight (loading vaults or saving). */
let busy = false;
/** Specifically a save is in flight; new files wait until it's done. */
let saving = false;
let vaultsLoaded = false;
/** The vault to preselect once vaults load: the one used last time. */
let preferredVaultId: string | null = null;

// ---------- status line ----------

type Tone = "info" | "ok" | "waiting" | "error";

/**
 * Whether the window is on screen, as far as this page knows: false until
 * the main process says it has been shown, and false again once hidden.
 * (A window that has never been shown still reports itself "visible", so
 * document.visibilityState alone can't tell.)
 */
let onScreen = false;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") onScreen = false;
});

/**
 * True when the current status was set while the window was off screen,
 * e.g. the "one file at a time" note for a Quick Action that started the app.
 * The user hasn't seen it yet, so showing the window must not clear it.
 */
let statusUnseen = false;

function setStatus(text: string, tone: Tone = "info", actions: Array<{ label: string; run: () => void }> = []): void {
  statusUnseen = !onScreen && text !== "";
  statusEl.textContent = text;
  statusEl.className = `status ${tone === "info" ? "" : tone}`;
  statusActions.replaceChildren(
    ...actions.map(({ label, run }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = label;
      button.addEventListener("click", run);
      return button;
    }),
  );
  statusActions.hidden = actions.length === 0;
}

/**
 * Run a call that may need 1Password's approval. If it takes a moment, say so:
 * the prompt can sit unanswered for minutes and the window must not look frozen.
 */
async function withPromptHint<T>(working: string, call: () => Promise<Result<T>>): Promise<Result<T>> {
  busy = true;
  updateSaveButton();
  setStatus(working, "info");
  const hint = setTimeout(() => {
    const { text, tone } = slowCallMessage(working, approval.promptLikely());
    setStatus(text, tone);
  }, PROMPT_HINT_AFTER_MS);
  try {
    const result = await call();
    approval.note(result);
    return result;
  } finally {
    clearTimeout(hint);
    busy = false;
    updateSaveButton();
  }
}

// ---------- account ----------

function showAccountView(error?: string): void {
  saveView.hidden = true;
  accountView.hidden = false;
  accountError.textContent = error ?? "";
  accountInput.focus();
  accountInput.select();
}

accountView.addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await api.setAccount(accountInput.value);
  if (!result.ok) {
    accountError.textContent = result.error.message;
    return;
  }
  vaultsLoaded = false;
  // A different account means a new session, which 1Password will ask about.
  approval.reset();
  showSaveView(result.value.lastVaultId);
});

// ---------- vaults ----------

async function loadVaults(preferredId: string | null): Promise<void> {
  vaultSelect.disabled = true;
  const result = await withPromptHint("Connecting to 1Password…", () => api.listVaults());
  if (!result.ok) {
    if (result.error.code === "ACCOUNT_NOT_FOUND") {
      showAccountView(`No 1Password account called “${accountInput.value || "that"}” is signed in.`);
      return;
    }
    vaultSelect.replaceChildren(new Option("No vaults loaded"));
    setStatus(describeError(result.error), "error", [{ label: "Try Again", run: () => void loadVaults(preferredId) }]);
    return;
  }
  fillVaults(result.value, preferredId);
  vaultsLoaded = true;
  setStatus(filePath ? "" : "Ready.");
  updateSaveButton();
}

function fillVaults(vaults: VaultSummary[], preferredId: string | null): void {
  vaultSelect.replaceChildren(...vaultOptions(vaults).map(({ value, label }) => new Option(label, value)));
  if (preferredId && vaults.some((v) => v.id === preferredId)) vaultSelect.value = preferredId;
  vaultSelect.disabled = vaults.length === 0;
}

// ---------- file ----------

function setFile(path: string | null): void {
  filePath = path;
  const name = path ? fileNameOf(path) : "";
  fileNameEl.textContent = name;
  fileNameEl.title = path ?? "";
  dropEmpty.hidden = path !== null;
  dropFile.hidden = path === null;
  drop.classList.toggle("has-file", path !== null);
  const title = titleFor(name);
  titleInput.value = title.value;
  if (path) {
    setStatus("");
    titleInput.focus();
    titleInput.setSelectionRange(title.selectStart, title.selectEnd);
  }
  updateSaveButton();
}

/**
 * Every new file goes through here, whether it came from Finder, the
 * menu-bar icon, a drop on the window or the file picker. During a save it
 * waits, so the file being saved is never swapped out.
 *
 * Only a save makes it wait, not any call to 1Password. On a fresh start the
 * window is loading vaults (and waiting for approval) just as the Quick
 * Action's file arrives; that file must show up straight away, not sit in
 * the queue that only a finished save releases.
 */
function offerFile(file: IncomingFile): void {
  if (incoming.offer(file, saving)) loadFile(file);
}

function loadFile(file: IncomingFile): void {
  setFile(file.path);
  const note = oneAtATimeNote(fileNameOf(file.path), file.othersIgnored);
  if (note) setStatus(note, "waiting");
}

/** " “next.pdf” is waiting." when a file is queued behind the current one, else "". */
function waitingNote(): string {
  const next = incoming.peek();
  return next ? ` “${fileNameOf(next.path)}” is waiting.` : "";
}

// Stop the page from ever opening a dropped file itself.
for (const type of ["dragover", "drop"] as const) {
  document.addEventListener(type, (event) => event.preventDefault());
}

drop.addEventListener("dragenter", () => drop.classList.add("over"));
drop.addEventListener("dragleave", (event) => {
  if (!drop.contains(event.relatedTarget as Node | null)) drop.classList.remove("over");
});
drop.addEventListener("drop", (event) => {
  drop.classList.remove("over");
  const files = [...(event.dataTransfer?.files ?? [])];
  const first = files[0];
  if (!first) return;
  const path = api.pathForFile(first);
  if (!path) {
    setStatus("That item isn't a file on disk.", "error");
    return;
  }
  offerFile({ path, othersIgnored: files.length - 1 });
});

const choose = async () => {
  const path = await api.chooseFile();
  if (path) offerFile({ path, othersIgnored: 0 });
};
chooseButton.addEventListener("click", () => void choose());
drop.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !filePath) {
    event.preventDefault();
    void choose();
  }
});
clearButton.addEventListener("click", () => {
  // The file can't be removed while it's being saved (the button is disabled
  // then too): that would bring up the waiting file mid-save, and the save
  // finishing would then clear it.
  if (saving) return;
  // Removing the current file brings up the one waiting behind it, if any.
  const next = incoming.take();
  if (next) {
    loadFile(next);
    return;
  }
  setFile(null);
  drop.focus();
});

// ---------- save ----------

function updateSaveButton(): void {
  saveButton.disabled = busy || !filePath || !vaultsLoaded || !vaultSelect.value;
  clearButton.disabled = saving;
}

async function save(allowDuplicate = false): Promise<void> {
  if (!filePath || busy || !vaultSelect.value) return;
  const vaultName = vaultSelect.selectedOptions[0]?.textContent ?? "the vault";
  const request = { filePath, vaultId: vaultSelect.value, title: titleInput.value, allowDuplicate };
  saving = true;
  let result;
  try {
    result = await withPromptHint("Saving…", () => api.save(request));
  } finally {
    saving = false;
    updateSaveButton();
  }
  if (result.ok) {
    const saved = savedMessage(result.value.title, vaultName, result.value.original);
    const next = incoming.take();
    if (next) {
      loadFile(next);
      setStatus(`${saved.text} Next: “${fileNameOf(next.path)}”.`, saved.tone);
      return;
    }
    setFile(null);
    setStatus(saved.text, saved.tone);
    drop.focus();
    return;
  }
  // The save failed: the current file stays so it can be dealt with, and any
  // file that arrived meanwhile keeps waiting (Remove brings it up).
  const { error } = result;
  if (error.code === "DUPLICATE_TITLE") {
    setStatus(describeError(error) + waitingNote(), "waiting", [
      { label: "Save Anyway", run: () => void save(true) },
      {
        label: "Rename",
        run: () => {
          setStatus("");
          titleInput.focus();
          titleInput.select();
        },
      },
    ]);
    return;
  }
  const retryable = isRetryable(error.code);
  // Try Again never carries "Save Anyway" over. A failed attempt may still
  // have stored the document (an expiry can be reported after the item
  // landed), so the retry runs the duplicate check again and, if a copy is
  // there, asks again rather than silently adding another.
  setStatus(describeError(error) + waitingNote(), "error", retryable ? [{ label: "Try Again", run: () => void save() }] : []);
}

saveView.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});
vaultSelect.addEventListener("change", () => {
  clearStalePrompt();
  updateSaveButton();
});
titleInput.addEventListener("input", clearStalePrompt);

trashCheckbox.addEventListener("change", async () => {
  const wanted = trashCheckbox.checked;
  const result = await api.setTrashAfterSave(wanted);
  if (!result.ok) {
    // Show what's actually in effect, never what was merely clicked.
    trashCheckbox.checked = !wanted;
    setStatus(`Couldn't change the Trash option: ${result.error.message}`, "error");
  }
});

/**
 * Remove leftover action buttons (Save Anyway, Try Again). They were offered
 * for one specific file, title and vault at one moment; once any of those
 * changes, or the window has been away, acting on them would do something the
 * user was never asked about.
 */
function clearStalePrompt(): void {
  if (!busy && !statusActions.hidden) setStatus("");
}

// ---------- window ----------

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void api.hide();
});

api.onShown(() => {
  const unseen = statusUnseen;
  onScreen = true;
  statusUnseen = false;
  if (saveView.hidden) return;
  (filePath ? titleInput : drop).focus();
  if (busy) return;
  // Start clean: no stale result or prompt from before the window was hidden.
  // A message set while the window was off screen is new, not stale: keep it.
  if (!unseen) setStatus(vaultsLoaded && !filePath ? "Ready." : "");
  // If the vaults never loaded (the approval was denied, say), reopening the
  // window is a natural moment to try again.
  if (!vaultsLoaded) void loadVaults(preferredVaultId);
});

function showSaveView(lastVaultId: string | null): void {
  preferredVaultId = lastVaultId;
  accountView.hidden = true;
  saveView.hidden = false;
  drop.focus();
  if (!vaultsLoaded) void loadVaults(lastVaultId);
}

const state = await api.getState();
trashCheckbox.checked = state.trashAfterSave;
if (state.accountName) {
  accountInput.value = state.accountName;
  showSaveView(state.lastVaultId);
} else {
  showAccountView();
}

// Files from Finder or the menu-bar icon. Listen first, then collect anything
// that arrived while the page was loading (a Quick Action that started the
// app), so nothing falls into the gap between the two.
api.onIncomingFile(offerFile);
const early = await api.takeIncomingFile();
if (early) offerFile(early);
