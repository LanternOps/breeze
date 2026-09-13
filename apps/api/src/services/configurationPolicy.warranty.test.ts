import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./automationReferenceAuthorization', () => ({
  AutomationReferenceAuthorizationError: class extends Error {},
  resolveOwnedAutomationReferences: vi.fn(),
}));
vi.mock('./automationRuntime', () => ({
  normalizeAutomationActions: vi.fn((a: unknown) => a),
  resolveAutomationReferencesForOwner: vi.fn(),
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { HP_CMSL_EULA_ID } from '@breeze/shared/validators';
import {
  WarrantyConsentError,
  addFeatureLink,
  resolveWarrantyInlineSettingsForWrite,
} from './configurationPolicy';
import { db } from '../db';

const ACTOR = { userId: 'user-1' };
const CURRENT_CONSENT = {
  acceptedByUserId: 'user-9',
  acceptedAt: '2026-01-01T00:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

describe('resolveWarrantyInlineSettingsForWrite', () => {
  it('passes the legacy alerting-only shape through untouched', () => {
    const out = resolveWarrantyInlineSettingsForWrite(
      { enabled: true, warnDays: 90, criticalDays: 30 },
      null,
      ACTOR,
    );
    expect(out).toEqual({ enabled: true, warnDays: 90, criticalDays: 30 });
  });

  it('throws on a client-supplied consent rather than stripping it (D3)', () => {
    expect(() =>
      resolveWarrantyInlineSettingsForWrite(
        { hpCmsl: { enabled: true, consent: CURRENT_CONSENT } },
        null,
        ACTOR,
      ),
    ).toThrow();
  });

  it('stamps consent server-side when collection is switched on', () => {
    const before = Date.now();
    const out = resolveWarrantyInlineSettingsForWrite({ hpCmsl: { enabled: true } }, null, ACTOR) as any;
    expect(out.hpCmsl.enabled).toBe(true);
    expect(out.hpCmsl.consent.acceptedByUserId).toBe('user-1');
    expect(out.hpCmsl.consent.eulaId).toBe(HP_CMSL_EULA_ID);
    expect(Date.parse(out.hpCmsl.consent.acceptedAt)).toBeGreaterThanOrEqual(before);
  });

  it('refuses to enable collection for a caller with no authenticated actor (the AI-tool door)', () => {
    expect(() =>
      resolveWarrantyInlineSettingsForWrite({ hpCmsl: { enabled: true } }, null, null),
    ).toThrow(WarrantyConsentError);
  });

  it('carries a still-current acceptance across an unrelated threshold edit without re-attributing it', () => {
    const stored = { warnDays: 90, hpCmsl: { enabled: true, consent: CURRENT_CONSENT } };
    const out = resolveWarrantyInlineSettingsForWrite(
      { warnDays: 45, hpCmsl: { enabled: true } },
      stored,
      ACTOR,
    ) as any;
    expect(out.warnDays).toBe(45);
    expect(out.hpCmsl.consent).toEqual(CURRENT_CONSENT);
  });

  it('lets an actor-less caller edit thresholds on an already-consented link', () => {
    const stored = { hpCmsl: { enabled: true, consent: CURRENT_CONSENT } };
    const out = resolveWarrantyInlineSettingsForWrite(
      { warnDays: 45, hpCmsl: { enabled: true } },
      stored,
      null,
    ) as any;
    expect(out.hpCmsl.consent).toEqual(CURRENT_CONSENT);
  });

  it('re-stamps when the recorded acceptance names a superseded EULA id (D2)', () => {
    const stored = { hpCmsl: { enabled: true, consent: { ...CURRENT_CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' } } };
    const out = resolveWarrantyInlineSettingsForWrite({ hpCmsl: { enabled: true } }, stored, ACTOR) as any;
    expect(out.hpCmsl.consent.acceptedByUserId).toBe('user-1');
    expect(out.hpCmsl.consent.eulaId).toBe(HP_CMSL_EULA_ID);
  });

  it('drops the recorded consent when collection is switched off, so re-enabling re-consents', () => {
    const stored = { hpCmsl: { enabled: true, consent: CURRENT_CONSENT } };
    const out = resolveWarrantyInlineSettingsForWrite({ hpCmsl: { enabled: false } }, stored, ACTOR) as any;
    expect(out.hpCmsl).toEqual({ enabled: false });
  });

  it('REPLACES, never merges: a payload that omits hpCmsl drops a consented block (contract D5)', () => {
    // Warranty updates are whole-blob replace. A caller that sends only
    // thresholds therefore revokes collection — deliberately the fail-safe
    // direction, and the reason WarrantyTab always sends hpCmsl explicitly.
    // Pinned so a future "helpful" merge cannot silently change it.
    const stored = { warnDays: 90, hpCmsl: { enabled: true, consent: CURRENT_CONSENT } };
    const out = resolveWarrantyInlineSettingsForWrite({ warnDays: 45 }, stored, ACTOR) as any;
    expect(out).toEqual({ warnDays: 45 });
    expect(out.hpCmsl).toBeUndefined();
  });

  it('leaves undefined/null settings alone (a featurePolicyId-only update)', () => {
    expect(resolveWarrantyInlineSettingsForWrite(undefined, null, ACTOR)).toBeUndefined();
    expect(resolveWarrantyInlineSettingsForWrite(null, null, ACTOR)).toBeNull();
  });
});

describe('addFeatureLink warranty backstop', () => {
  beforeEach(() => vi.clearAllMocks());

  it('refuses an actor-less enable before opening a transaction', async () => {
    await expect(
      addFeatureLink('policy-1', 'warranty', null, { hpCmsl: { enabled: true } }),
    ).rejects.toThrow(WarrantyConsentError);
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('refuses a forged consent before opening a transaction', async () => {
    await expect(
      addFeatureLink('policy-1', 'warranty', null, { hpCmsl: { enabled: true, consent: CURRENT_CONSENT } }, { userId: 'user-1' }),
    ).rejects.toThrow();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });
});
