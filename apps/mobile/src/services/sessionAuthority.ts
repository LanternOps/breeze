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
 */
export function beginSessionInvalidation(): SessionInvalidation {
  const generation = advanceSessionGeneration();
  return {
    generation,
    cleanup: commitIfCurrent(generation, clearAuthData),
  };
}
