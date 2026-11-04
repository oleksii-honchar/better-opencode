import { Database } from "bun:sqlite"
import path from "path"

// DB path resolution for the Session Inspector (DEC-E, spec §5.1-4).
// Mirrors storage/db.ts getPath()/getChannelPath() EXACTLY (measured at 4dc7a5d31, L31-44):
//   OPENCODE_DB set → ":memory:" or absolute used verbatim, otherwise joined onto the data dir;
//   else channel ∈ {latest, beta, prod} or disableChannelDb → <data>/opencode.db;
//   else → <data>/opencode-<channel sanitized by [^a-zA-Z0-9._-] → "-">.db
// The engine's env/Global/InstallationChannel/RuntimeFlags sources are injected as a typed
// object (no process.env at point of use); tests exercise every branch with plain data.
// DEC-E: an explicit config file path (paths.dbMode !== "engine-derived") wins LAST; the second
// live DB is reachable ONLY by that explicit selection — no scanning, no automatic merging.

export const DEFAULT_CHANNEL_DB = "opencode.db"
const DEFAULT_CHANNELS = ["latest", "beta", "prod"]

export interface EngineDbInputs {
  envOpenCodeDb: string | undefined
  channel: string
  disableChannelDb: boolean
  dataDir: string
}

// Neutral default inputs; the composition seam overrides with the live engine values.
export const DEFAULT_ENGINE_INPUTS: Omit<EngineDbInputs, "dataDir"> = {
  envOpenCodeDb: undefined,
  channel: "local",
  disableChannelDb: false,
}

export interface ResolveInspectorDbPathInput {
  dbMode: string
  engine: EngineDbInputs
}

export function resolveInspectorDbPath(input: ResolveInspectorDbPathInput): string {
  if (input.dbMode !== "engine-derived") {
    return input.dbMode
  }
  if (input.engine.envOpenCodeDb) {
    if (input.engine.envOpenCodeDb === ":memory:" || path.isAbsolute(input.engine.envOpenCodeDb)) {
      return input.engine.envOpenCodeDb
    }
    return path.join(input.engine.dataDir, input.engine.envOpenCodeDb)
  }
  return channelDbPath(input.engine)
}

function channelDbPath(engine: EngineDbInputs): string {
  if (DEFAULT_CHANNELS.includes(engine.channel) || engine.disableChannelDb) {
    return path.join(engine.dataDir, DEFAULT_CHANNEL_DB)
  }
  const safe = engine.channel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(engine.dataDir, `opencode-${safe}.db`)
}

// Read-only open, never migrates, never checkpoints: no write-mode handle is ever taken,
// so WAL side effects and migrations are physically impossible through this seam.
export function openInspectorDb(dbPath: string): Database {
  return new Database(dbPath, { readonly: true })
}
