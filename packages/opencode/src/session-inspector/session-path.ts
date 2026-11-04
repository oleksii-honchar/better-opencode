// Per-session folder resolution through the REAL contract: one bounded spawn of
// resolve-session-path.mjs `resolve <sessionId>` (DEC-0011 invariant, reused verbatim;
// ADR-0011 §4: spawn-not-import, path is CONTRACT). The caller (endpoint layer) owns
// calling it exactly ONCE per session view; the fallback walk lives there because it
// uses module-internal scan IO.

export type ResolveOutcome = { ok: true; path: string } | { ok: false; reason: string }

/** Injectable process-spawn seam; argv is passed as a real argument list (never joined). */
export type SpawnResolver = (argv: readonly string[], env: Record<string, string>) => { exitCode: number; stdout: string }

export function makeResolverSessionPath(
  spawn: SpawnResolver,
  resolverPath: string,
): (sessionId: string, agentsRoot: string) => ResolveOutcome {
  return (sessionId, agentsRoot) => {
    const result = spawn([resolverPath, "resolve", sessionId], { AGENT_SESSIONS_DIR: agentsRoot })
    if (result.exitCode !== 0) {
      return { ok: false, reason: `resolver exited ${result.exitCode}: ${result.stdout.trim().slice(0, 200)}` }
    }
    const printed = result.stdout.split("\n").map((line) => line.trim()).find((line) => line.length > 0)
    if (printed === undefined) return { ok: false, reason: "resolver exited 0 without printing a path" }
    return { ok: true, path: printed }
  }
}
