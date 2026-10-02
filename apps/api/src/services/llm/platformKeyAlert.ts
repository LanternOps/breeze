/**
 * Hourly-throttled Sentry reports for the LLM credential paths. A leaf module
 * (sentry only) so both the legacy resolver (llmConfigResolver.ts) and the
 * W03 connection factory (aiModels/connectionFactory.ts, which must not
 * value-import the resolver: module-init cycle) share ONE throttle — the
 * blank-platform-key alert keeps the same event code and the same hourly
 * window whichever path hit it first.
 */
import { captureMessage } from '../sentry';

const SENTRY_CAPTURE_THROTTLE_MS = 60 * 60 * 1000;
const sentryCaptureTimestamps = new Map<string, number>();

export function captureAtMostHourly(key: string, capture: () => void): void {
  const now = Date.now();
  const lastCapture = sentryCaptureTimestamps.get(key);
  if (lastCapture !== undefined && now - lastCapture < SENTRY_CAPTURE_THROTTLE_MS) return;
  sentryCaptureTimestamps.set(key, now);
  capture();
}

export const PLATFORM_KEY_MISSING_MESSAGE = 'AI is not configured on this deployment.';

/** The deployment has no platform credential but a platform call was attempted. */
export function reportPlatformKeyMissing(): void {
  captureAtMostHourly('blank-platform-key:platform', () => {
    captureMessage(PLATFORM_KEY_MISSING_MESSAGE, { eventCode: 'llm_platform_key_missing' });
  });
}

export function __resetPlatformKeyAlertForTests(): void {
  sentryCaptureTimestamps.clear();
}
