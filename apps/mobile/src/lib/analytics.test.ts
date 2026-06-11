// Smoke tests for the analytics gating layer. We never test the PostHog SDK
// itself — only that the wrapper's "no-op when disabled" contract holds and
// that initAnalytics is safe to call regardless of config. The real SDK is
// loaded lazily inside initAnalytics so this test never imports the RN
// module under Node/Vitest.

import { describe, expect, it } from 'vitest';

import {
  __isAnalyticsEnabled,
  identify,
  initAnalytics,
  reset,
  track,
} from './analytics';

describe('analytics gating', () => {
  it('is disabled when EXPO_PUBLIC_POSTHOG_KEY is unset', () => {
    // Vitest's Node env doesn't define __DEV__ as truthy, but the gate also
    // requires the key. Without the key, the module reports disabled.
    expect(process.env.EXPO_PUBLIC_POSTHOG_KEY).toBeUndefined();
    expect(__isAnalyticsEnabled()).toBe(false);
  });

  it('initAnalytics is a safe no-op when disabled', () => {
    // No throw, no side effect we can detect from the outside.
    expect(() => initAnalytics()).not.toThrow();
  });

  it('track / identify / reset are no-ops when disabled', () => {
    expect(() => track('some_event')).not.toThrow();
    expect(() => track('some_event', { length: 12 })).not.toThrow();
    expect(() => identify('user-123', { email: 'a@b.test', name: 'Test' })).not.toThrow();
    expect(() => reset()).not.toThrow();
  });
});
