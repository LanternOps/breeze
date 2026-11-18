import { describe, it, expect, vi, beforeEach } from 'vitest';

// OD-11 (#10190 W01): a newly created Breeze Assist (helper) feature link
// deploys Assist unless the request says otherwise. Only the create path
// changes; updates keep what they are sent, and devices with no helper policy
// keep HELPER_DEFAULTS (enabled: false).

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
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

import { addFeatureLink, updateFeatureLink } from './configurationPolicy';
import { helperSettingsFromRows } from './helperSettings';
import { db } from '../db';

/** A transaction whose link insert records the JSONB it was given. */
function insertingTx() {
  const stored: { inline?: unknown } = {};
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn((v: { inlineSettings?: unknown }) => {
        stored.inline = v.inlineSettings;
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{
              id: 'link-1', configPolicyId: 'policy-1', featureType: 'helper', featurePolicyId: null, inlineSettings: v.inlineSettings,
            }])),
          })),
        };
      }),
    })),
  };
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));
  return stored;
}

describe('helper feature link create default (OD-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a helper feature link with enabled:true when omitted', async () => {
    const stored = insertingTx();
    await addFeatureLink('policy-1', 'helper', null, { showOpenPortal: false });
    expect(stored.inline).toEqual({ showOpenPortal: false, enabled: true });
  });

  it('creates a helper feature link with enabled:true when no settings are sent', async () => {
    for (const inline of [undefined, null]) {
      const stored = insertingTx();
      await addFeatureLink('policy-1', 'helper', null, inline);
      expect(stored.inline).toEqual({ enabled: true });
    }
  });

  it('keeps an explicit enabled:false on create', async () => {
    const stored = insertingTx();
    await addFeatureLink('policy-1', 'helper', null, { enabled: false, showDeviceInfo: true });
    expect(stored.inline).toEqual({ enabled: false, showDeviceInfo: true });
  });

  it('does not add enabled to other feature types', async () => {
    const stored = insertingTx();
    await addFeatureLink('policy-1', 'pam', null, {});
    expect(stored.inline).not.toHaveProperty('enabled');
  });

  it('updating a helper link without enabled does not flip it', async () => {
    const set = vi.fn((_values: Record<string, unknown>) => ({
      where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 'link-1' }])) })),
    }));
    const tx: any = {
      select: vi.fn(() => {
        const chain: any = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve([
          { id: 'link-1', configPolicyId: 'policy-1', featureType: 'helper', featurePolicyId: null, inlineSettings: { enabled: false } },
        ]));
        return chain;
      }),
      update: vi.fn(() => ({ set })),
      delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
      insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve([])) })),
    };
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(tx));

    await updateFeatureLink('link-1', { inlineSettings: { showOpenPortal: false } }, 'policy-1');

    const written = set.mock.calls.find((args) => args[0] && 'inlineSettings' in args[0])?.[0].inlineSettings;
    expect(written).toEqual({ showOpenPortal: false });
    expect(helperSettingsFromRows([{ level: 'organization', assignmentPriority: 0, inlineSettings: written }])?.enabled).toBe(false);
  });

  it('HELPER_DEFAULTS.enabled stays false', () => {
    // A helper policy whose settings do not decide `enabled` resolves to the
    // default, which must stay off: OD-11 (c), deploying wherever no policy
    // says otherwise, was rejected (it would silently install software fleet-wide).
    expect(helperSettingsFromRows([{ level: 'organization', assignmentPriority: 0, inlineSettings: { showOpenPortal: true } }])?.enabled).toBe(false);
  });
});
