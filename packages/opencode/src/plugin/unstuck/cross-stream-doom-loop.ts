// Compile ignore patterns once and return a function that checks if a serialized
// tool input matches any pattern. Patterns are regex strings from config.doomLoopIgnorePatterns.
// Match against the JSON.stringify(input) string used for fingerprinting.
export function isIgnored(patterns: string[]): (serialized: string) => boolean {
  const regexes = patterns.map((p) => new RegExp(p))
  if (regexes.length === 0) return () => false
  return (serialized: string) => regexes.some((re) => re.test(serialized))
}

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

export class CrossStreamDoomLoopManagerImpl implements CrossStreamDoomLoopManager {
  // Single-state design: one DoomLoopRunState per session.
  // Weakness (memory 0015): if the model calls tool A, then tool B, then tool A again
  // with the same input, the count resets to 1 instead of continuing. Only truly
  // consecutive identical tool+input calls across streams are caught.
  private sessions = new Map<string, DoomLoopRunState>();

  recordCall(sessionId: string, toolName: string, inputFingerprint: string, threshold: number): boolean {
    const current = this.sessions.get(sessionId);

    if (current && current.toolName === toolName && current.inputFingerprint === inputFingerprint) {
      current.count += 1;
      return current.count >= threshold;
    }

    this.sessions.set(sessionId, { toolName, inputFingerprint, count: 1 });
    return 1 >= threshold;
  }

  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clearAll(): void {
    this.sessions.clear();
  }
}
