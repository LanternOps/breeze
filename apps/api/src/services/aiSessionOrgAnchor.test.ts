import { describe, expect, it } from 'vitest';
import {
  buildSessionContextSnapshot,
  pageContextWriteDefaultOrgId,
  PAGE_CONTEXT_ORG_ANCHOR,
  SESSION_ORG_ANCHOR_KEY,
} from './aiSessionOrgAnchor';

const ORG = 'aaaaaaaa-1111-4222-8333-444455556666';
const DEVICE = 'dddddddd-1111-4222-8333-444455556666';
const devicePage = { type: 'device' as const, id: DEVICE, hostname: 'WS-01' };
const anchored = { ...devicePage, [SESSION_ORG_ANCHOR_KEY]: PAGE_CONTEXT_ORG_ANCHOR };

describe('buildSessionContextSnapshot (#6675)', () => {
  it('records the page-context anchor when the session org came from the page', () => {
    expect(buildSessionContextSnapshot(devicePage, true)).toEqual(anchored);
  });

  it('records nothing when the org came from elsewhere', () => {
    expect(buildSessionContextSnapshot(devicePage, false)).toEqual(devicePage);
  });

  it('strips an anchor key smuggled in with the page context', () => {
    expect(buildSessionContextSnapshot(anchored as never, false)).toEqual(devicePage);
  });

  it('is null without a page context', () => {
    expect(buildSessionContextSnapshot(undefined, false)).toBeNull();
  });
});

describe('pageContextWriteDefaultOrgId (#6675)', () => {
  it('returns the session org for a page-anchored device session', () => {
    expect(pageContextWriteDefaultOrgId({ orgId: ORG, deviceId: null, contextSnapshot: anchored })).toBe(ORG);
  });

  it('returns undefined when the session org was not anchored by the page', () => {
    expect(pageContextWriteDefaultOrgId({ orgId: ORG, deviceId: null, contextSnapshot: devicePage })).toBeUndefined();
  });

  it('returns undefined for a device-bound session (its tool auth is already org-pinned)', () => {
    expect(pageContextWriteDefaultOrgId({ orgId: ORG, deviceId: DEVICE, contextSnapshot: anchored })).toBeUndefined();
  });

  it('returns undefined for a non-device snapshot carrying the key', () => {
    const snap = { type: 'dashboard', [SESSION_ORG_ANCHOR_KEY]: PAGE_CONTEXT_ORG_ANCHOR };
    expect(pageContextWriteDefaultOrgId({ orgId: ORG, deviceId: null, contextSnapshot: snap })).toBeUndefined();
  });

  it('returns undefined for a missing or malformed snapshot', () => {
    expect(pageContextWriteDefaultOrgId({ orgId: ORG, deviceId: null, contextSnapshot: null })).toBeUndefined();
    expect(pageContextWriteDefaultOrgId({ orgId: ORG, contextSnapshot: 'x' })).toBeUndefined();
    expect(pageContextWriteDefaultOrgId({ orgId: ORG })).toBeUndefined();
  });
});
