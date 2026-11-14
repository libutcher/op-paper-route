/**
 * Owns the one long-lived SDK client.
 *
 * Desktop-app authorization is granted per process and lapses after ten
 * minutes of inactivity or when 1Password locks (confirmed in M0: every new
 * process got its own Touch ID prompt). So the app keeps a single Session,
 * connects lazily on first use — that is when the prompt appears — and drops
 * the client when the SDK reports the session expired, so the next call
 * prompts again instead of failing forever.
 */

import sdk from "@1password/sdk";
import type { Client } from "@1password/sdk";
import type { OnePasswordClient } from "./client.js";
import { fromSdkError } from "./errors.js";

export interface ConnectOptions {
  /** Account name as shown in the 1Password sidebar, or its account UUID. */
  accountName: string;
  /** Shown to the user in the approval prompt. */
  integrationName: string;
  integrationVersion: string;
}

export type Connect = (options: ConnectOptions) => Promise<OnePasswordClient>;

export interface SessionOptions extends ConnectOptions {
  /** Replaces the SDK connection; tests inject a fake here. */
  connect?: Connect;
}

/** The real thing: triggers the 1Password approval prompt. */
export const connectWithSdk: Connect = async (options) => {
  const client: Client = await sdk.createClient({
    auth: new sdk.DesktopAuth(options.accountName),
    integrationName: options.integrationName,
    integrationVersion: options.integrationVersion,
  });
  // Structural check that the SDK's Client still satisfies our narrow interface.
  const narrowed: OnePasswordClient = client;
  return narrowed;
};

export class Session {
  readonly #options: ConnectOptions;
  readonly #connect: Connect;
  /** In-flight or completed connection. Shared so concurrent first calls cause one prompt. */
  #pending: Promise<OnePasswordClient> | null = null;
  /** The attempt in #pending that has resolved, if any. */
  #resolved: Promise<OnePasswordClient> | null = null;

  constructor(options: SessionOptions) {
    const { connect, ...connectOptions } = options;
    this.#options = connectOptions;
    this.#connect = connect ?? connectWithSdk;
  }

  /** True once the current connection attempt has succeeded and not since been dropped. */
  get isConnected(): boolean {
    return this.#pending !== null && this.#pending === this.#resolved;
  }

  /** The shared client, authenticating on first use. Failures are PaperRouteErrors. */
  client(): Promise<OnePasswordClient> {
    if (!this.#pending) {
      // Each attempt is its own promise. The handlers only touch session state
      // while that attempt is still the current one, so a slow attempt that
      // settles after disconnect() or a newer attempt can't overwrite it.
      const attempt: Promise<OnePasswordClient> = this.#connect(this.#options).then(
        (client) => {
          if (this.#pending === attempt) this.#resolved = attempt;
          return client;
        },
        (err: unknown) => {
          this.#drop(attempt);
          throw fromSdkError(err);
        },
      );
      this.#pending = attempt;
    }
    return this.#pending;
  }

  /** Forget the client. The next call connects again, which prompts the user again. */
  disconnect(): void {
    this.#pending = null;
    this.#resolved = null;
  }

  /** Drop `attempt` only if it is still current; a newer connection is left alone. */
  #drop(attempt: Promise<OnePasswordClient>): void {
    if (this.#pending === attempt) this.disconnect();
  }

  /**
   * Run one operation against the client. Anything thrown comes back as a
   * PaperRouteError. On SESSION_EXPIRED the client is dropped and, when
   * `reauth` is true (the default), the operation is retried once — which
   * shows the approval prompt again.
   *
   * Only retry operations that are safe to repeat. An expiry can be reported
   * after the work was done (the app locking mid-call), so a write that is
   * retried may happen twice. Pass `reauth: false` for creates; the caller
   * then surfaces SESSION_EXPIRED and the user's retry goes through any
   * duplicate check first.
   */
  async run<T>(operation: (client: OnePasswordClient) => Promise<T>, { reauth = true } = {}): Promise<T> {
    const attempt = this.client();
    try {
      return await operation(await attempt);
    } catch (err) {
      const error = fromSdkError(err);
      if (error.code === "SESSION_EXPIRED") {
        // Drop only the connection this operation used. If another operation
        // has already reconnected, its fresh (just-approved) client stays.
        this.#drop(attempt);
        if (reauth) return this.run(operation, { reauth: false });
      }
      throw error;
    }
  }
}
