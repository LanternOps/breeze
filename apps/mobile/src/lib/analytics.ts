// PostHog product analytics. Funnel-building set only — see App.tsx for the
// App Store Connect privacy declaration this implies.
//
// Gating rules:
//   - Disabled unless EXPO_PUBLIC_POSTHOG_KEY is set AND !__DEV__.
//   - When disabled, every export is a no-op so callers don't need to gate.
//   - Every event fire is wrapped in try/catch so a broken SDK can never
//     crash a render. We intentionally swallow errors: there is no surface
//     to report them to except Sentry, and the analytics path is too hot
//     to flood Sentry on a misconfiguration.
//
// PRIVACY: do not pass chat content, approval action labels, hostnames, or
// any other potentially-customer-data string. Only the structural metadata
// listed in the event table.

// Type-only import so the SDK's RN-only modules never load in test runners
// (vitest's Node env can't parse some of posthog-react-native's transitive
// deps). The actual SDK is loaded lazily via require() inside initAnalytics.
import type PostHogType from 'posthog-react-native';

let client: PostHogType | null = null;

const POSTHOG_KEY = process.env.EXPO_PUBLIC_POSTHOG_KEY;
const POSTHOG_HOST = process.env.EXPO_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
const ENABLED = !!POSTHOG_KEY && !__DEV__;

export function initAnalytics(): void {
  if (!ENABLED || client) return;
  try {
    // Lazy require keeps the SDK out of every importer's module graph —
    // matters for vitest under Node, and shaves init cost when analytics
    // is disabled (e.g. dev builds, tests).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PostHog = require('posthog-react-native').default as typeof PostHogType;
    client = new PostHog(POSTHOG_KEY as string, {
      host: POSTHOG_HOST,
      // Default capture=true but autocapture is intentionally left at the
      // SDK default; we curate events explicitly via track() calls so we
      // don't ship navigation telemetry that wasn't reviewed.
    });
  } catch {
    // Init failure → leave client null so subsequent track/identify/reset
    // are no-ops. Do not re-throw; analytics must never crash the app.
    client = null;
  }
}

export function track(event: string, properties?: Record<string, unknown>): void {
  if (!client) return;
  try {
    // PostHog's PostHogEventProperties demands a JsonType-constrained
    // record; our callers pass plain primitives + booleans + numbers so
    // the cast is sound. Keeping the public API as Record<string, unknown>
    // means callers don't have to import a PostHog type just to call us.
    client.capture(event, properties as Record<string, never> | undefined);
  } catch {
    // Silent fail — see file header.
  }
}

export function identify(userId: string, traits?: Record<string, unknown>): void {
  if (!client) return;
  try {
    client.identify(userId, traits as Record<string, never> | undefined);
  } catch {
    // Silent fail.
  }
}

export function reset(): void {
  if (!client) return;
  try {
    client.reset();
  } catch {
    // Silent fail.
  }
}

// Test-only — lets us verify the no-op gating path without poking at module
// internals. Returns true iff initAnalytics would actually wire a client.
export function __isAnalyticsEnabled(): boolean {
  return ENABLED;
}
