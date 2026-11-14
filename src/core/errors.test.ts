import sdk from "@1password/sdk";
import { describe, expect, it } from "vitest";
import { PaperRouteError, fromSdkError } from "./errors.js";

describe("fromSdkError", () => {
  it("passes a PaperRouteError through untouched", () => {
    const original = new PaperRouteError("VAULT_NOT_FOUND", "nope", { details: { vaultId: "v1" } });
    expect(fromSdkError(original)).toBe(original);
  });

  it("maps the SDK's typed errors by class", () => {
    expect(fromSdkError(new sdk.DesktopSessionExpiredError("expired")).code).toBe("SESSION_EXPIRED");
    expect(fromSdkError(new sdk.AuthExpiredError("expired")).code).toBe("SESSION_EXPIRED");
    expect(fromSdkError(new sdk.RateLimitExceededError("slow down")).code).toBe("RATE_LIMITED");
  });

  it("maps known plain-Error messages by substring", () => {
    // Exact message observed in M0 when the account name didn't match.
    const accountErr = new Error(
      "An error occurred when processing SDK request: Error { msg: Account not found, inner: None }",
    );
    expect(fromSdkError(accountErr).code).toBe("ACCOUNT_NOT_FOUND");

    // From shared_lib_core.js when the app or its dylib is missing.
    expect(fromSdkError(new Error("1Password desktop application not found")).code).toBe("APP_NOT_FOUND");
    expect(fromSdkError(new Error("Native library is not available.")).code).toBe("APP_NOT_FOUND");
  });

  it("maps authorization wording to NOT_AUTHORIZED without over-matching", () => {
    expect(fromSdkError(new Error("request denied by user")).code).toBe("NOT_AUTHORIZED");
    expect(fromSdkError(new Error("account is locked")).code).toBe("NOT_AUTHORIZED");
    // "blocked" contains "locked" but is not an authorization failure.
    expect(fromSdkError(new Error("port blocked")).code).toBe("UNKNOWN");
  });

  it("falls back to UNKNOWN and keeps the original message and cause", () => {
    const cause = new Error("something novel");
    const err = fromSdkError(cause);
    expect(err.code).toBe("UNKNOWN");
    expect(err.message).toContain("something novel");
    expect(err.cause).toBe(cause);
  });

  it("copes with non-Error throwables", () => {
    expect(fromSdkError("just a string").code).toBe("UNKNOWN");
    expect(fromSdkError("just a string").message).toContain("just a string");
    expect(fromSdkError(undefined).code).toBe("UNKNOWN");
  });

  it("keeps the SDK error as cause when mapping", () => {
    const cause = new sdk.DesktopSessionExpiredError("expired");
    expect(fromSdkError(cause).cause).toBe(cause);
  });
});

describe("PaperRouteError", () => {
  it("is an Error with a stable name, code and details", () => {
    const err = new PaperRouteError("FILE_TOO_LARGE", "too big", { details: { encoded: 10, limit: 5 } });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PaperRouteError");
    expect(err.code).toBe("FILE_TOO_LARGE");
    expect(err.details).toEqual({ encoded: 10, limit: 5 });
  });

  it("defaults details to an empty object", () => {
    expect(new PaperRouteError("UNKNOWN", "x").details).toEqual({});
  });
});
