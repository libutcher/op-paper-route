import { describe, expect, it } from "vitest";
import type { ApiError, ErrorCode, Result } from "./api.js";
import {
  APPROVAL_IDLE_MS,
  ApprovalTracker,
  describeError,
  fileNameOf,
  isRetryable,
  slowCallMessage,
  titleFor,
  vaultOptions,
} from "./window-logic.js";

const fail = (code: ErrorCode, details: ApiError["details"] = {}): { ok: false; error: ApiError } => ({
  ok: false,
  error: { code, message: `${code} message`, details },
});
const ok: Result<string> = { ok: true, value: "x" };

describe("isRetryable", () => {
  it("offers Try Again only where resending the same request can work", () => {
    for (const code of ["NOT_AUTHORIZED", "SESSION_EXPIRED", "RATE_LIMITED", "APP_NOT_FOUND", "UNKNOWN"] as const) {
      expect(isRetryable(code), code).toBe(true);
    }
    for (const code of [
      "INVALID_REQUEST",
      "FILE_UNREADABLE",
      "FILE_TOO_LARGE",
      "DUPLICATE_TITLE",
      "VERIFY_FAILED",
      "VAULT_NOT_FOUND",
      "VAULT_AMBIGUOUS",
      "ACCOUNT_NOT_FOUND",
    ] as const) {
      expect(isRetryable(code), code).toBe(false);
    }
  });
});

describe("ApprovalTracker", () => {
  function tracker() {
    let now = 1_000_000;
    const t = new ApprovalTracker(() => now);
    return { t, advance: (ms: number) => (now += ms) };
  }

  it("expects a prompt before 1Password has answered anything", () => {
    expect(tracker().t.promptLikely()).toBe(true);
  });

  it("doesn't expect one right after a successful call", () => {
    const { t } = tracker();
    t.note(ok);
    expect(t.promptLikely()).toBe(false);
  });

  it("expects one again once the approval would have ended", () => {
    const { t, advance } = tracker();
    t.note(ok);
    advance(APPROVAL_IDLE_MS);
    expect(t.promptLikely()).toBe(false);
    advance(1);
    expect(t.promptLikely()).toBe(true);
  });

  it("expects one after an error that means approval is missing or gone", () => {
    for (const code of ["NOT_AUTHORIZED", "SESSION_EXPIRED", "ACCOUNT_NOT_FOUND", "APP_NOT_FOUND"] as const) {
      const { t } = tracker();
      t.note(ok);
      t.note(fail(code));
      expect(t.promptLikely(), code).toBe(true);
    }
  });

  it("counts other 1Password errors as an answer (1Password replied)", () => {
    const { t } = tracker();
    t.note(fail("DUPLICATE_TITLE"));
    expect(t.promptLikely()).toBe(false);
  });

  it("ignores errors raised before 1Password is contacted", () => {
    for (const code of ["INVALID_REQUEST", "FILE_UNREADABLE", "FILE_TOO_LARGE"] as const) {
      const fresh = tracker();
      fresh.t.note(fail(code));
      expect(fresh.t.promptLikely(), `${code} before any answer`).toBe(true);

      const approved = tracker();
      approved.t.note(ok);
      approved.t.note(fail(code));
      expect(approved.t.promptLikely(), `${code} after an answer`).toBe(false);
    }
  });

  it("reset() forgets the approval (switching accounts)", () => {
    const { t } = tracker();
    t.note(ok);
    t.reset();
    expect(t.promptLikely()).toBe(true);
  });
});

describe("slowCallMessage", () => {
  it("asks for approval only when a prompt is likely", () => {
    expect(slowCallMessage("Saving…", true)).toEqual({
      text: "Waiting for 1Password — approve the request in the 1Password app.",
      tone: "waiting",
    });
    expect(slowCallMessage("Saving…", false)).toMatchObject({ tone: "info", text: expect.stringContaining("Saving… Still working") });
  });
});

describe("titleFor", () => {
  it("keeps the extension in the title but selects only the name", () => {
    expect(titleFor("receipt.pdf")).toEqual({ value: "receipt.pdf", selectStart: 0, selectEnd: 7 });
  });

  it("selects up to the last dot only", () => {
    expect(titleFor("tax.2025.final.pdf")).toEqual({ value: "tax.2025.final.pdf", selectStart: 0, selectEnd: 14 });
  });

  it("selects everything when there's no extension, or the only dot is leading", () => {
    expect(titleFor("README")).toMatchObject({ selectEnd: 6 });
    expect(titleFor(".env")).toMatchObject({ selectEnd: 4 });
  });
});

describe("fileNameOf", () => {
  it("returns the last path component", () => {
    expect(fileNameOf("/Users/me/Downloads/receipt.pdf")).toBe("receipt.pdf");
    expect(fileNameOf("receipt.pdf")).toBe("receipt.pdf");
  });
});

describe("vaultOptions", () => {
  it("adds part of the id only to titles that repeat", () => {
    expect(
      vaultOptions([
        { id: "aaaaaa111", title: "Shopping" },
        { id: "bbbbbb222", title: "Personal Docs" },
        { id: "cccccc333", title: "Shopping" },
      ]),
    ).toEqual([
      { value: "aaaaaa111", label: "Shopping (aaaaaa)" },
      { value: "bbbbbb222", label: "Personal Docs" },
      { value: "cccccc333", label: "Shopping (cccccc)" },
    ]);
  });
});

describe("describeError", () => {
  it("explains size limits with the numbers involved", () => {
    const MB = 1024 * 1024;
    expect(describeError(fail("FILE_TOO_LARGE", { bytes: 20 * MB, encoded: 60 * MB, limit: 50 * MB }).error)).toBe(
      "Too large: this file needs 60.0 MB and the limit is 50.0 MB.",
    );
    expect(describeError(fail("FILE_TOO_LARGE", { bytes: 3072 * MB, maxFileBytes: 25 * MB }).error)).toBe(
      "Too large: 3072.0 MB, and nothing over 25.0 MB can fit.",
    );
  });

  it("names the duplicate, and falls back to the error's own message", () => {
    expect(describeError(fail("DUPLICATE_TITLE", { title: "receipt.pdf" }).error)).toBe(
      "A document called “receipt.pdf” is already in this vault.",
    );
    expect(describeError(fail("VAULT_NOT_FOUND").error)).toBe("VAULT_NOT_FOUND message");
  });
});
