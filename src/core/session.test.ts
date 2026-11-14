import sdk from "@1password/sdk";
import { describe, expect, it, vi } from "vitest";
import type { OnePasswordClient } from "./client.js";
import { PaperRouteError } from "./errors.js";
import { Session, type Connect } from "./session.js";

const OPTIONS = { accountName: "Test Account", integrationName: "PaperRoute tests", integrationVersion: "0" };

/** A client whose vaults.list runs a scripted sequence of outcomes. */
function fakeClient(...outcomes: Array<unknown[] | Error>): OnePasswordClient {
  let call = 0;
  return {
    vaults: {
      list: vi.fn(async () => {
        const outcome = outcomes[Math.min(call++, outcomes.length - 1)];
        if (outcome instanceof Error) throw outcome;
        return outcome as never;
      }),
    },
    items: {
      list: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      files: { read: vi.fn() },
    },
  };
}

/** A connect() that hands out the given clients in order and counts calls. */
function fakeConnect(...clients: Array<OnePasswordClient | Error>) {
  let call = 0;
  return vi.fn<Connect>(async (): Promise<OnePasswordClient> => {
    const next = clients[Math.min(call++, clients.length - 1)];
    if (next instanceof Error) throw next;
    return next!;
  });
}

describe("Session", () => {
  it("does not connect until something is asked of it", () => {
    const connect = fakeConnect(fakeClient([]));
    const session = new Session({ ...OPTIONS, connect });
    expect(connect).not.toHaveBeenCalled();
    expect(session.isConnected).toBe(false);
  });

  it("connects once and reuses the client", async () => {
    const connect = fakeConnect(fakeClient([]));
    const session = new Session({ ...OPTIONS, connect });

    await session.run((c) => c.vaults.list());
    await session.run((c) => c.vaults.list());

    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith(OPTIONS);
    expect(session.isConnected).toBe(true);
  });

  it("shares one connection between concurrent first calls (one prompt, not two)", async () => {
    const connect = fakeConnect(fakeClient([]));
    const session = new Session({ ...OPTIONS, connect });

    await Promise.all([session.run((c) => c.vaults.list()), session.run((c) => c.vaults.list())]);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("reports a failed connection as a PaperRouteError and allows a retry", async () => {
    const connect = fakeConnect(
      new Error("An error occurred when processing SDK request: Error { msg: Account not found, inner: None }"),
      fakeClient([]),
    );
    const session = new Session({ ...OPTIONS, connect });

    await expect(session.run((c) => c.vaults.list())).rejects.toMatchObject({
      name: "PaperRouteError",
      code: "ACCOUNT_NOT_FOUND",
    });
    expect(session.isConnected).toBe(false);

    // The failed attempt is not cached: the next call connects again.
    await expect(session.run((c) => c.vaults.list())).resolves.toEqual([]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("re-authenticates once when the session expires mid-operation", async () => {
    const first = fakeClient(new sdk.DesktopSessionExpiredError("expired"));
    const second = fakeClient([{ id: "v1", title: "Vault" }]);
    const connect = fakeConnect(first, second);
    const session = new Session({ ...OPTIONS, connect });

    await expect(session.run((c) => c.vaults.list())).resolves.toEqual([{ id: "v1", title: "Vault" }]);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(second.vaults.list).toHaveBeenCalledTimes(1);
    expect(session.isConnected).toBe(true);
  });

  it("treats 'invalid client id' (1Password locked mid-session) as expiry and reconnects", async () => {
    // Exactly what the live probe recorded after locking the app mid-session.
    const revoked = fakeClient(new Error("invalid client id"));
    const fresh = fakeClient([{ id: "v1", title: "Vault" }]);
    const connect = fakeConnect(revoked, fresh);
    const session = new Session({ ...OPTIONS, connect });

    await expect(session.run((c) => c.vaults.list())).resolves.toEqual([{ id: "v1", title: "Vault" }]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(session.isConnected).toBe(true);
  });

  it("does not retry a denied prompt, and lets the next call prompt again", async () => {
    const denied = new Error(
      "An error occurred when processing SDK request: Error { msg: Denied authorization for SDK client, inner: None }",
    );
    const connect = fakeConnect(denied, fakeClient([]));
    const session = new Session({ ...OPTIONS, connect });

    await expect(session.run((c) => c.vaults.list())).rejects.toMatchObject({ code: "NOT_AUTHORIZED" });
    expect(connect).toHaveBeenCalledTimes(1);

    await expect(session.run((c) => c.vaults.list())).resolves.toEqual([]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("gives up after one re-authentication if the session keeps expiring", async () => {
    const connect = fakeConnect(fakeClient(new sdk.DesktopSessionExpiredError("expired")));
    const session = new Session({ ...OPTIONS, connect });

    await expect(session.run((c) => c.vaults.list())).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(session.isConnected).toBe(false);
  });

  it("does not retry when reauth is off, but still drops the client", async () => {
    const connect = fakeConnect(fakeClient(new sdk.DesktopSessionExpiredError("expired")));
    const session = new Session({ ...OPTIONS, connect });

    await expect(session.run((c) => c.vaults.list(), { reauth: false })).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(session.isConnected).toBe(false);
  });

  it("keeps the client on errors that are not session expiry", async () => {
    const connect = fakeConnect(fakeClient(new Error("something else")));
    const session = new Session({ ...OPTIONS, connect });

    await expect(session.run((c) => c.vaults.list())).rejects.toMatchObject({ code: "UNKNOWN" });
    expect(session.isConnected).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("passes a PaperRouteError thrown by the operation through unchanged", async () => {
    const session = new Session({ ...OPTIONS, connect: fakeConnect(fakeClient([])) });
    const mine = new PaperRouteError("VAULT_NOT_FOUND", "no such vault");

    await expect(
      session.run(async () => {
        throw mine;
      }),
    ).rejects.toBe(mine);
  });

  it("a late expiry from the old connection does not drop a fresh one (one re-prompt, not two)", async () => {
    // Two operations start on the same connection; both will see it expire,
    // but B's expiry arrives only after A has already reconnected.
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => (releaseB = resolve));
    const expired = () => new sdk.DesktopSessionExpiredError("expired");
    const oldClient = fakeClient([]);
    oldClient.vaults.list = vi.fn(async () => {
      throw expired();
    });
    oldClient.items.list = vi.fn(async () => {
      await bGate;
      throw expired();
    });
    const freshClient = fakeClient([{ id: "v1", title: "Vault" }]);
    freshClient.items.list = vi.fn(async () => []);
    const connect = fakeConnect(oldClient, freshClient, fakeClient([]));
    const session = new Session({ ...OPTIONS, connect });

    const b = session.run((c) => c.items.list("v1"));
    await expect(session.run((c) => c.vaults.list())).resolves.toEqual([{ id: "v1", title: "Vault" }]);
    expect(connect).toHaveBeenCalledTimes(2);

    releaseB();
    await expect(b).resolves.toEqual([]);

    // B's late expiry left A's fresh connection in place and reused it.
    expect(connect).toHaveBeenCalledTimes(2);
    expect(session.isConnected).toBe(true);
  });

  it("a connection that resolves after disconnect() does not mark the session connected", async () => {
    let resolveConnect!: (c: OnePasswordClient) => void;
    const connect = vi.fn<Connect>(() => new Promise((resolve) => (resolveConnect = resolve)));
    const session = new Session({ ...OPTIONS, connect });

    const pending = session.client();
    session.disconnect();
    resolveConnect(fakeClient([]));
    await pending;

    expect(session.isConnected).toBe(false);
  });

  it("disconnect() forces a fresh connection next time", async () => {
    const connect = fakeConnect(fakeClient([]));
    const session = new Session({ ...OPTIONS, connect });

    await session.run((c) => c.vaults.list());
    session.disconnect();
    expect(session.isConnected).toBe(false);

    await session.run((c) => c.vaults.list());
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
