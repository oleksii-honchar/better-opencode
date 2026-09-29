/**
 * Shared signal for force_new_turn mid-turn interruption.
 *
 * This module provides a thread-safe signal that can be set by
 * flushInjectedMessages (in tools.ts or prompt.ts) and checked by
 * the main loop (in prompt.ts). Using a shared signal instead of
 * exception-based control flow avoids the issue where the AI SDK's
 * internal error handling catches and converts the exception to a
 * tool error, preventing it from reaching the main loop's try-catch.
 */

let requested = false

/**
 * Request a new turn. Called by flushInjectedMessages when a
 * force_new_turn flag is detected in injected messages.
 */
export const requestNewTurn = (): void => {
  requested = true
}

/**
 * Check if a new turn was requested and reset the signal.
 * Returns true if a new turn was requested, false otherwise.
 */
export const checkAndResetNewTurnRequested = (): boolean => {
  const wasRequested = requested
  requested = false
  return wasRequested
}
