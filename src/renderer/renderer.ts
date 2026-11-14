/**
 * The Paper Route window. Runs in a sandboxed page; everything it does goes
 * through `window.paperRoute` (see src/app/preload.cts).
 *
 * The flow is built to be finished without thinking: drop a file, the title
 * is filled in, the last vault is already selected, press Return.
 */

import type { ApiError, ErrorCode, PaperRouteApi, Result, VaultSummary } from "../shared/api.js";

declare global {
  interface Window {
    paperRoute: PaperRouteApi;
  }
}

const api = window.paperRoute;

/** Errors where the same request may succeed if sent again. */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["NOT_AUTHORIZED", "SESSION_EXPIRED", "RATE_LIMITED", "APP_NOT_FOUND", "UNKNOWN"]);

/** After this long without an answer, 1Password is probably showing its prompt. */
const PROMPT_HINT_AFTER_MS = 1500;

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
const statusEl = $<HTMLDivElement>("status");
const statusActions = $<HTMLDivElement>("status-actions");

let filePath: string | null = null;
let busy = false;
let vaultsLoaded = false;

// ---------- status line ----------

type Tone = "info" | "ok" | "waiting" | "error";

function setStatus(text: string, tone: Tone = "info", actions: Array<{ label: string; run: () => void }> = []): void {
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
  const hint = setTimeout(
    () => setStatus("Waiting for 1Password — approve the request in the 1Password app.", "waiting"),
    PROMPT_HINT_AFTER_MS,
  );
  try {
    return await call();
  } finally {
    clearTimeout(hint);
    busy = false;
    updateSaveButton();
  }
}

function describeError(error: ApiError): string {
  const d = error.details;
  const mb = (n: unknown) => `${(Number(n) / 1024 / 1024).toFixed(1)} MB`;
  switch (error.code) {
    case "NOT_AUTHORIZED":
      return "1Password didn't approve the request.";
    case "SESSION_EXPIRED":
      return "The 1Password session ended. Try again to approve a new one.";
    case "APP_NOT_FOUND":
      return "1Password isn't running, or “Integrate with 1Password SDKs” is off in Settings → Developer.";
    case "FILE_TOO_LARGE":
      return "encoded" in d
        ? `Too large: this file needs ${mb(d.encoded)} and the limit is ${mb(d.limit)}.`
        : `Too large: ${mb(d.bytes)}, and nothing over ${mb(d.maxFileBytes)} can fit.`;
    case "DUPLICATE_TITLE":
      return `A document called “${String(d.title)}” is already in this vault.`;
    default:
      return error.message;
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
  // Vault titles repeat in real accounts, so disambiguate those that do.
  const counts = new Map<string, number>();
  for (const v of vaults) counts.set(v.title, (counts.get(v.title) ?? 0) + 1);
  vaultSelect.replaceChildren(
    ...vaults.map((v) => new Option((counts.get(v.title) ?? 0) > 1 ? `${v.title} (${v.id.slice(0, 6)})` : v.title, v.id)),
  );
  if (preferredId && vaults.some((v) => v.id === preferredId)) vaultSelect.value = preferredId;
  vaultSelect.disabled = vaults.length === 0;
}

// ---------- file ----------

function setFile(path: string | null): void {
  filePath = path;
  const name = path ? (path.split("/").pop() ?? path) : "";
  fileNameEl.textContent = name;
  fileNameEl.title = path ?? "";
  dropEmpty.hidden = path !== null;
  dropFile.hidden = path === null;
  drop.classList.toggle("has-file", path !== null);
  // Pre-fill the title from the file name, without the extension; editable.
  titleInput.value = path ? name.replace(/\.[^.]+$/, "") : "";
  if (path) {
    setStatus("");
    titleInput.focus();
    titleInput.select();
  }
  updateSaveButton();
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
  setFile(path);
  if (files.length > 1) setStatus(`Saving one file at a time; using “${first.name}”.`, "waiting");
});

const choose = async () => {
  const path = await api.chooseFile();
  if (path) setFile(path);
};
chooseButton.addEventListener("click", () => void choose());
drop.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && !filePath) {
    event.preventDefault();
    void choose();
  }
});
clearButton.addEventListener("click", () => {
  setFile(null);
  drop.focus();
});

// ---------- save ----------

function updateSaveButton(): void {
  saveButton.disabled = busy || !filePath || !vaultsLoaded || !vaultSelect.value;
}

async function save(allowDuplicate = false): Promise<void> {
  if (!filePath || busy || !vaultSelect.value) return;
  const vaultName = vaultSelect.selectedOptions[0]?.textContent ?? "the vault";
  const result = await withPromptHint("Saving…", () =>
    api.save({ filePath: filePath!, vaultId: vaultSelect.value, title: titleInput.value, allowDuplicate }),
  );
  if (result.ok) {
    setFile(null);
    setStatus(`Saved “${result.value.title}” to ${vaultName}.`, "ok");
    drop.focus();
    return;
  }
  const { error } = result;
  if (error.code === "DUPLICATE_TITLE") {
    setStatus(describeError(error), "waiting", [
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
  // Offer Try Again only where trying again can work. Input problems
  // (INVALID_REQUEST), a bad file or a failed verification need something to
  // change first.
  const retryable = RETRYABLE.has(error.code);
  // Try Again never carries "Save Anyway" over. A failed attempt may still
  // have stored the document (an expiry can be reported after the item
  // landed), so the retry runs the duplicate check again and, if a copy is
  // there, asks again rather than silently adding another.
  setStatus(describeError(error), "error", retryable ? [{ label: "Try Again", run: () => void save() }] : []);
}

saveView.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});
vaultSelect.addEventListener("change", updateSaveButton);

// ---------- window ----------

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") void api.hide();
});

api.onShown(() => {
  if (!saveView.hidden) (filePath ? titleInput : drop).focus();
});

function showSaveView(lastVaultId: string | null): void {
  accountView.hidden = true;
  saveView.hidden = false;
  drop.focus();
  if (!vaultsLoaded) void loadVaults(lastVaultId);
}

const state = await api.getState();
if (state.accountName) {
  accountInput.value = state.accountName;
  showSaveView(state.lastVaultId);
} else {
  showAccountView();
}
