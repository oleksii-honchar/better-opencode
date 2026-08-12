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
