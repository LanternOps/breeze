import { clearAuthData } from './auth';
import {
  advanceSessionGeneration,
  commitIfCurrent,
} from './sessionGeneration';

export interface SessionInvalidation {
  generation: number;
  cleanup: Promise<void | undefined>;
}

/**
 * Synchronously supersede every request/write from the old session, then put
 * the complete secure wipe on the same serialized queue as authority writes.
 *
 * `deliberate` is threaded through to `clearAuthData` and decides whether the
 * unsent time-entry backlog is discarded. It defaults to false: an involuntary
 * session loss (token expiry, locked keychain, device block) must not cost a
 * technician a day of offline work.
 */
export function beginSessionInvalidation(
  options: Readonly<{ deliberate?: boolean }> = {}
): SessionInvalidation {
  const generation = advanceSessionGeneration();
  return {
    generation,
    cleanup: commitIfCurrent(generation, () => clearAuthData(options)),
  };
}
