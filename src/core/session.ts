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
  #connected = false;

  constructor(options: SessionOptions) {
    const { connect, ...connectOptions } = options;
    this.#options = connectOptions;
    this.#connect = connect ?? connectWithSdk;
  }

  /** True once a client has been obtained and not since dropped. */
  get isConnected(): boolean {
    return this.#connected;
  }

  /** The shared client, authenticating on first use. Failures are PaperRouteErrors. */
  client(): Promise<OnePasswordClient> {
    if (!this.#pending) {
      this.#pending = this.#connect(this.#options).then(
        (client) => {
          this.#connected = true;
          return client;
        },
        (err: unknown) => {
          this.#pending = null;
          throw fromSdkError(err);
        },
      );
    }
    return this.#pending;
  }

  /** Forget the client. The next call connects again, which prompts the user again. */
  disconnect(): void {
    this.#pending = null;
    this.#connected = false;
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
    try {
      return await operation(await this.client());
    } catch (err) {
      const error = fromSdkError(err);
      if (error.code === "SESSION_EXPIRED") {
        this.disconnect();
        if (reauth) return this.run(operation, { reauth: false });
      }
      throw error;
    }
  }
}
