/**
 * Shared cap tying offline condition durations to the offline re-evaluation
 * sweep horizon. Conditions longer than this horizon could never fire after
 * a device ages out of the sweep, so validation and evaluation share this cap.
 */
import { envInt } from '../../utils/envInt';

export const DEFAULT_REEVAL_HORIZON_MINUTES = 1440; // 24h

/** Resolve the re-eval horizon (minutes) from env, clamped to >= 1. */
export function resolveReevalHorizonMinutes(): number {
  return Math.max(
    1,
    envInt('OFFLINE_DETECTOR_REEVAL_HORIZON_MINUTES', DEFAULT_REEVAL_HORIZON_MINUTES)
  );
}
