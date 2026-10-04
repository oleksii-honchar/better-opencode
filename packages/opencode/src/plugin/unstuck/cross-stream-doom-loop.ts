// Compile ignore patterns once and return a function that checks if a serialized
// tool input matches any pattern. Patterns are regex strings from config.doomLoopIgnorePatterns.
// Match against the JSON.stringify(input) string used for fingerprinting.
export function isIgnored(patterns: string[]): (serialized: string) => boolean {
  const regexes = patterns.map((p) => new RegExp(p))
  if (regexes.length === 0) return () => false
  return (serialized: string) => regexes.some((re) => re.test(serialized))
}

// Kept for API compatibility (re-exported from index.ts). The manager no longer
// stores one of these per session — DEC-1 replaced it with per-key counts.
export interface DoomLoopRunState {
  toolName: string;
  inputFingerprint: string;
  count: number;
}

export interface CrossStreamDoomLoopManager {
  recordCall(sessionId: string, toolName: string, inputFingerprint: string, threshold: number): boolean;
  resetSession(sessionId: string): void;
  clearAll(): void;
}

// Per-session cap on tracked (tool, fingerprint) keys. On overflow the
// oldest-inserted key is dropped (Map/Set insertion order) so long-lived
// processes cannot grow the map without bound.
export const MAX_KEYS_PER_SESSION = 64;

export class CrossStreamDoomLoopManagerImpl implements CrossStreamDoomLoopManager {
  // Per-(session, tool, fingerprint) counts (DEC-1, supersedes the single-state
  // design): interleaved A-B-A-B calls no longer reset each other's counts.
  // Key format: `${sessionId}\u0000${toolName}\u0000${inputFingerprint}` — NUL
  // separator keeps tool names/fingerprints containing arbitrary characters from
  // colliding.
  private runs = new Map<string, { count: number }>();
  // Index sessionId -> its run keys, for resetSession and per-session eviction.
  private sessionKeys = new Map<string, Set<string>>();

  recordCall(sessionId: string, toolName: string, inputFingerprint: string, threshold: number): boolean {
    const key = `${sessionId}\u0000${toolName}\u0000${inputFingerprint}`;

    const current = this.runs.get(key);
    if (current) {
      current.count += 1;
      return current.count >= threshold;
    }

    this.runs.set(key, { count: 1 });
    let keys = this.sessionKeys.get(sessionId);
    if (!keys) {
      keys = new Set<string>();
      this.sessionKeys.set(sessionId, keys);
    }
    keys.add(key);

    // Per-session cap: drop the oldest-inserted key (Set insertion order).
    while (keys.size > MAX_KEYS_PER_SESSION) {
      const oldest = keys.values().next().value as string;
      keys.delete(oldest);
      this.runs.delete(oldest);
    }

    return 1 >= threshold;
  }

  resetSession(sessionId: string): void {
    const keys = this.sessionKeys.get(sessionId);
    if (!keys) return;
    for (const key of keys) {
      this.runs.delete(key);
    }
    this.sessionKeys.delete(sessionId);
  }

  clearAll(): void {
    this.runs.clear();
    this.sessionKeys.clear();
  }
}
