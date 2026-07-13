import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __testOnly,
  assertAuthBrowserTransitionRolloutCompatible,
} from './authBrowserTransitionRollout';

const ORIGINAL_ENFORCEMENT = process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED;

describe('auth browser transition rollout compatibility', () => {
  afterEach(() => {
    if (ORIGINAL_ENFORCEMENT === undefined) {
      delete process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED;
    } else {
      process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED = ORIGINAL_ENFORCEMENT;
    }
  });

  it('permits a mixed-replica preparation deploy while enforcement is disabled', () => {
    process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED = 'false';
    expect(() => __testOnly.assertCompatible(true)).not.toThrow();
  });

  it('rejects startup when enforcement is enabled while the legacy issuer export exists', () => {
    process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED = 'true';
    expect(() => __testOnly.assertCompatible(true))
      .toThrow(/legacy user-session issuer export/i);
  });

  it('accepts enforcement only after the legacy issuer export is absent', () => {
    process.env.AUTH_BROWSER_TRANSITIONS_ENFORCED = 'true';
    expect(() => __testOnly.assertCompatible(false)).not.toThrow();
    expect(() => assertAuthBrowserTransitionRolloutCompatible()).not.toThrow();
  });

  it('mechanically binds the runtime marker to the actual user-session export type', () => {
    const source = readFileSync(new URL('./authBrowserTransitionRollout.ts', import.meta.url), 'utf8');
    expect(source).toContain("keyof typeof import('./userSession')");
    expect(source).toContain("'issueUserSessionLegacyDuringTransition'");
  });
});
