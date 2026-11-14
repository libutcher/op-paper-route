/**
 * Paper Route core: save local documents into 1Password. No UI, no Electron.
 *
 *   const session = new Session({ accountName, integrationName, integrationVersion });
 *   const vaults = await listVaults(session);          // pick by id — titles repeat
 *   const saved = await saveDocument(session, { filePath, vaultId: vaults[0].id });
 */

export type { OnePasswordClient } from "./client.js";
export { PaperRouteError, fromSdkError, messageFor, type ErrorCode, type ErrorDetails } from "./errors.js";
export {
  ALWAYS_FITS_BYTES,
  MAX_ENCODED_BYTES,
  NEVER_FITS_BYTES,
  SDK_MESSAGE_LIMIT,
  checkFits,
  encodedSize,
  sizeHint,
  type FitCheck,
} from "./limits.js";
export { saveDocument, type SaveRequest, type SaveResult } from "./save.js";
export { Session, connectWithSdk, type Connect, type ConnectOptions, type SessionOptions } from "./session.js";
export { findVault, listVaults, type VaultSummary } from "./vaults.js";
