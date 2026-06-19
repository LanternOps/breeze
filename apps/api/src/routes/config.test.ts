import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  authRef: {
    current: {
      orgId: '11111111-1111-4111-8111-111111111111',
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-4111-8111-111111111111',
    },
  },
  resolveAllMlFeatureFlagsForOrg: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', mocks.authRef.current);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/mlFeatureFlags', () => ({
  resolveAllMlFeatureFlagsForOrg: mocks.resolveAllMlFeatureFlagsForOrg,
}));

import { configRoutes } from './config';

describe('GET /config', () => {
  const originalEnv = process.env.BREEZE_BILLING_URL;
  const originalReg = process.env.ENABLE_REGISTRATION;

  beforeEach(() => {
    delete process.env.BREEZE_BILLING_URL;
    delete process.env.ENABLE_REGISTRATION;
    mocks.authRef.current = {
      orgId: '11111111-1111-4111-8111-111111111111',
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-4111-8111-111111111111',
    };
    mocks.resolveAllMlFeatureFlagsForOrg.mockReset();
    mocks.resolveAllMlFeatureFlagsForOrg.mockResolvedValue({
      'ml.rca.enabled': {
        flag: 'ml.rca.enabled',
        enabled: false,
        defaultEnabled: false,
        source: 'org_settings',
      },
      'ml.remediation_suggestions.enabled': {
        flag: 'ml.remediation_suggestions.enabled',
        enabled: true,
        defaultEnabled: false,
        source: 'org_settings',
      },
    });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BREEZE_BILLING_URL;
    } else {
      process.env.BREEZE_BILLING_URL = originalEnv;
    }
    if (originalReg === undefined) {
      delete process.env.ENABLE_REGISTRATION;
    } else {
      process.env.ENABLE_REGISTRATION = originalReg;
    }
  });

  const request = async () => {
    const app = new Hono().route('/config', configRoutes);
    const res = await app.request('/config');
    return { status: res.status, body: await res.json() as any };
  };

  it('returns both flags false when BREEZE_BILLING_URL unset', async () => {
    const { status, body } = await request();
    expect(status).toBe(200);
    expect(body.features).toEqual({ billing: false, support: false });
  });

  it('returns both flags true when BREEZE_BILLING_URL is set', async () => {
    process.env.BREEZE_BILLING_URL = 'http://localhost:4000';
    const { status, body } = await request();
    expect(status).toBe(200);
    expect(body.features).toEqual({ billing: true, support: true });
  });

  it('registration.enabled defaults to false when ENABLE_REGISTRATION unset', async () => {
    const { body } = await request();
    expect(body.registration).toEqual({ enabled: false });
  });

  it('registration.enabled is true when ENABLE_REGISTRATION=true (runtime, #1308)', async () => {
    process.env.ENABLE_REGISTRATION = 'true';
    const { body } = await request();
    expect(body.registration).toEqual({ enabled: true });
  });

  it('registration.enabled is false when ENABLE_REGISTRATION=false', async () => {
    process.env.ENABLE_REGISTRATION = 'false';
    const { body } = await request();
    expect(body.registration).toEqual({ enabled: false });
  });

  it('returns authenticated org-scoped ML feature flag resolutions', async () => {
    const app = new Hono().route('/config', configRoutes);
    const res = await app.request('/config/ml-feature-flags');

    expect(res.status).toBe(200);
    expect(mocks.resolveAllMlFeatureFlagsForOrg).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    const body = await res.json();
    expect(body.orgId).toBe('11111111-1111-4111-8111-111111111111');
    expect(body.mlFeatureFlags['ml.rca.enabled']).toMatchObject({ enabled: false, source: 'org_settings' });
    expect(body.data).toEqual(body.mlFeatureFlags);
  });

  it('rejects ML feature flag requests for inaccessible orgs', async () => {
    const app = new Hono().route('/config', configRoutes);
    const res = await app.request('/config/ml-feature-flags?orgId=22222222-2222-4222-8222-222222222222');

    expect(res.status).toBe(403);
    expect(mocks.resolveAllMlFeatureFlagsForOrg).not.toHaveBeenCalled();
  });
});
