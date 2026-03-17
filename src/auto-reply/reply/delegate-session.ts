import { updateSessionStoreEntry } from "../../config/sessions/store.js";
import { logVerbose } from "../../globals.js";

export type DelegateSessionMode = "active" | "background";

/**
 * Clear or rewrite the legacy delegateMode marker on persisted sessions.
 */
export async function updateDelegateMode(params: {
  storePath: string;
  sessionKey: string;
  mode: DelegateSessionMode | undefined;
}): Promise<void> {
  const { storePath, sessionKey, mode } = params;
  await updateSessionStoreEntry({
    storePath,
    sessionKey,
    update: async () => ({ delegateMode: mode }),
  });
  logVerbose(`delegate-session: mode → ${mode ?? "off"} (${sessionKey})`);
}
