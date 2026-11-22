import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  resolveEffectiveConfigMock,
  previewEffectiveConfigMock,
  configFeatureTypes,
  selectMock,
  tableResults,
} = vi.hoisted(() => ({
  resolveEffectiveConfigMock: vi.fn(),
  previewEffectiveConfigMock: vi.fn(),
  selectMock: vi.fn(),
  tableResults: new Map<string, unknown[]>(),
  configFeatureTypes: [
    'patch',
    'backup',
    'security',
    'maintenance',
    'compliance',
    'automation',
    'event_log',
    'software_policy',
    'sensitive_data',
    'peripheral_control',
    'warranty',
    'helper',
    'remote_access',
    'pam',
    'onedrive_helper',
  ],
}));

vi.mock('../../services/configurationPolicy', () => ({
  CONFIG_FEATURE_TYPES: configFeatureTypes,
  resolveEffectiveConfig: resolveEffectiveConfigMock,
  previewEffectiveConfig: previewEffectiveConfigMock,
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
}));

// db.select() dispatches on the mocked table's name, so each statement gets its
// own rows whatever order the route issues them in.
vi.mock('../../db', () => ({
  db: { select: selectMock },
}));

vi.mock('../../db/schema', () => ({
  devices: { _name: 'devices', id: 'id', siteId: 'site_id' },
  configurationPolicies: { _name: 'configurationPolicies', id: 'id', orgId: 'org_id' },
}));

import { resolutionRoutes } from './resolution';
import { getPolicyBaselineDefaults } from '../../services/policyBaselineDefaults';
import { requireScope, requirePermission } from '../../middleware/auth';

// Auth wiring is asserted in its own block (no beforeEach clearAllMocks) so the
// import-time guard registrations on the routes are still recorded. Without this,
// stripping the guards from /baseline would leave the 200 route test green.
describe('resolution routes auth wiring', () => {
  it('registers the same scope + permission guards as sibling routes', () => {
    expect(requireScope).toHaveBeenCalledWith('organization', 'partner', 'system');
    expect(requirePermission).toHaveBeenCalled();
  });
});

// The handler returns the static registry verbatim. We assert the registry's
// shape is what the endpoint will serialize (no DB needed).
describe('GET /baseline payload shape', () => {
  it('returns every feature with label/applied/behavior', () => {
    const features = getPolicyBaselineDefaults();
    expect(features.length).toBeGreaterThanOrEqual(17);
    for (const f of features) {
      expect(typeof f.label).toBe('string');
      expect(typeof f.behavior).toBe('string');
      expect(typeof f.applied).toBe('boolean');
    }
    const ra = features.find((f) => f.featureType === 'remote_access')!;
    expect(ra.applied).toBe(true);
  });
});

describe('configurationPolicies resolution routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/', resolutionRoutes);
  });

  it('returns the static baseline registry', async () => {
    const res = await app.request('/baseline');

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.features)).toBe(true);
    expect(json.features).toEqual(getPolicyBaselineDefaults());
  });
});

describe('GET /effective/:deviceId policyOwners', () => {
  const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
  const ORG_POLICY = '22222222-2222-4222-8222-222222222222';
  const PARTNER_POLICY = '33333333-3333-4333-8333-333333333333';
  const CHAIN_ONLY_POLICY = '44444444-4444-4444-8444-444444444444';
  const HIDDEN_POLICY = '55555555-5555-4555-8555-555555555555';
  let app: Hono;
  let policyIdsAsked: unknown[] = [];

  function feature(featureType: string, sourcePolicyId: string, sourceLevel = 'organization') {
    return {
      featureType, featurePolicyId: null, inlineSettings: {}, sourceLevel, sourceTargetId: 'target',
      sourcePolicyId, sourcePolicyName: 'P', sourcePriority: 0,
      inheritedFromPolicyId: null, inheritedFromPolicyName: null,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tableResults.clear();
    policyIdsAsked = [];
    selectMock.mockImplementation(() => ({
      from: (table: { _name: string }) => {
        const rows = tableResults.get(table._name) ?? [];
        const whereResult = Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
        return {
          where: (cond: unknown) => {
            if (table._name === 'configurationPolicies') policyIdsAsked.push(cond);
            return whereResult;
          },
        };
      },
    }));
    tableResults.set('devices', [{ siteId: 'site-1' }]);
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth', { scope: 'partner', partnerId: 'partner-1' } as never);
      await next();
    });
    app.route('/', resolutionRoutes);
  });

  it('GET /effective/:deviceId carries policyOwners for winners and chain rows', async () => {
    resolveEffectiveConfigMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      features: {
        patch: feature('patch', ORG_POLICY),
        backup: feature('backup', PARTNER_POLICY, 'partner'),
      },
      inheritanceChain: [
        { level: 'organization', targetId: 't', policyId: ORG_POLICY, policyName: 'Org', priority: 0, featureTypes: ['patch'] },
        { level: 'partner', targetId: 't', policyId: PARTNER_POLICY, policyName: 'MSP', priority: 0, featureTypes: ['backup'] },
        { level: 'site', targetId: 't', policyId: CHAIN_ONLY_POLICY, policyName: 'Lost', priority: 0, featureTypes: [] },
        { level: 'device', targetId: 't', policyId: HIDDEN_POLICY, policyName: 'Hidden', priority: 0, featureTypes: [] },
      ],
    });
    // HIDDEN_POLICY is not returned by the caller-context select: no key.
    tableResults.set('configurationPolicies', [
      { id: ORG_POLICY, orgId: 'org-1', partnerId: null },
      { id: PARTNER_POLICY, orgId: null, partnerId: 'partner-1' },
      { id: CHAIN_ONLY_POLICY, orgId: 'org-2', partnerId: null },
    ]);

    const res = await app.request(`/effective/${DEVICE_ID}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.policyOwners).toEqual({
      [ORG_POLICY]: 'organization',
      [PARTNER_POLICY]: 'partner',
      [CHAIN_ONLY_POLICY]: 'organization',
    });
    // The resolver's own output is passed through unchanged.
    expect(json.features.patch.sourcePolicyId).toBe(ORG_POLICY);
    expect(json.inheritanceChain).toHaveLength(4);
    expect(policyIdsAsked).toHaveLength(1);
  });

  it('a row with neither an org nor a partner owner gets no key', async () => {
    resolveEffectiveConfigMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      features: { patch: feature('patch', ORG_POLICY) },
      inheritanceChain: [
        { level: 'organization', targetId: 't', policyId: ORG_POLICY, policyName: 'Odd', priority: 0, featureTypes: ['patch'] },
      ],
    });
    tableResults.set('configurationPolicies', [{ id: ORG_POLICY, orgId: null, partnerId: null }]);

    const res = await app.request(`/effective/${DEVICE_ID}`);
    expect(res.status).toBe(200);
    expect((await res.json()).policyOwners).toEqual({});
  });

  it('the Breeze Defaults sentinel gets no policyOwners entry', async () => {
    resolveEffectiveConfigMock.mockResolvedValue({
      deviceId: DEVICE_ID,
      features: {
        patch: feature('patch', 'breeze-defaults', 'default'),
      },
      inheritanceChain: [
        { level: 'default', targetId: 'breeze-defaults', policyId: 'breeze-defaults', policyName: 'Breeze Defaults', priority: 0, featureTypes: ['patch'] },
      ],
    });
    // Even if a lookup ran and echoed the sentinel back, it must not be keyed.
    tableResults.set('configurationPolicies', [{ id: 'breeze-defaults', orgId: null, partnerId: null }]);

    const res = await app.request(`/effective/${DEVICE_ID}`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.policyOwners).toEqual({});
    // Nothing real to look up, so no owner query ran (a non-uuid in a uuid IN would error).
    expect(policyIdsAsked).toHaveLength(0);
  });
});
