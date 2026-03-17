import { updateSessionStoreEntry } from "../../config/sessions/store.js";
import { logVerbose } from "../../globals.js";

export type CodexSessionMode = "active" | "background";

/**
 * Clear or rewrite the legacy codexMode marker on persisted sessions.
 */
export async function updateCodexMode(params: {
  storePath: string;
  sessionKey: string;
  mode: CodexSessionMode | undefined;
}): Promise<void> {
  const { storePath, sessionKey, mode } = params;
  await updateSessionStoreEntry({
    storePath,
    sessionKey,
    update: async () => ({ codexMode: mode }),
  });
  logVerbose(`codex-session: mode → ${mode ?? "off"} (${sessionKey})`);
}

/**
 * Update the per-session Codex working directory override.
 * Pass `undefined` to clear the override and fall back to defaults.
 */
export async function updateCodexWorkspaceDir(params: {
  storePath: string;
  sessionKey: string;
  dir: string | undefined;
}): Promise<void> {
  const { storePath, sessionKey, dir } = params;
  await updateSessionStoreEntry({
    storePath,
    sessionKey,
    update: async () => ({ codexWorkspaceDir: dir }),
  });
  logVerbose(`codex-session: workspace dir → ${dir ?? "(cleared)"} (${sessionKey})`);
}
