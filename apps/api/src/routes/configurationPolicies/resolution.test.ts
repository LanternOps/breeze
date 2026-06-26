import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const {
  resolveEffectiveConfigMock,
  previewEffectiveConfigMock,
  configFeatureTypes,
} = vi.hoisted(() => ({
  resolveEffectiveConfigMock: vi.fn(),
  previewEffectiveConfigMock: vi.fn(),
  configFeatureTypes: [
    'patch',
    'alert_rule',
    'backup',
    'security',
    'monitoring',
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

vi.mock('../../db', () => ({
  db: {},
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'id', siteId: 'site_id' },
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
