import { beforeEach, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import type { AuthContext } from '../middleware/auth';
import { createSystemAuthContext } from '../services/featureConfigResolver';
const h = vi.hoisted(() => ({ counts: vi.fn(), report: vi.fn(), authenticated: true, permitted: true }));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: Context, next: () => Promise<void>) => h.authenticated ? next() : c.json({ error: 'Unauthorized' }, 401),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (c: Context, next: () => Promise<void>) => h.permitted ? next() : c.json({ error: 'Forbidden' }, 403),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../services/monitors/conversion', () => ({
  countPendingConversions: h.counts, previewPolicyConversion: vi.fn(), previewPartnerConversion: vi.fn(),
  convertPolicy: vi.fn(), convertPartnerLegacy: vi.fn(), revertConversion: vi.fn(), retireSource: vi.fn(),
  listConversionLedger: vi.fn(), ConversionError: class extends Error {},
  ConversionPrerequisiteMissingError: class extends Error {},
}));
vi.mock('../services/monitors/conversion/loadSources', () => ({ readRetirementReport: h.report }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
import { monitorConversionRoutes } from './monitorDefinitions.conversion';
const ORG = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
function request(orgId = ORG) {
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use('*', async (c, next) => {
    c.set('auth', { ...createSystemAuthContext(), scope: 'organization', orgId: ORG,
      canAccessOrg: (id: string) => id === ORG });
    await next();
  });
  app.route('/monitor-definitions/conversion', monitorConversionRoutes);
  return app.request(`/monitor-definitions/conversion/pending?orgId=${orgId}`);
}
beforeEach(() => {
  vi.clearAllMocks();
  h.authenticated = h.permitted = true;
  h.counts.mockResolvedValue({ policies: 0, rows: 0, pendingPolicies: [] });
  h.report.mockResolvedValue({ unconvertible: [], sweep: null });
});
it('returns the report and passes the selected org to its authorized loader', async () => {
  const report = { unconvertible: [{ sourceTable: 'config_policy_alert_rules', sourceId: OTHER,
    name: 'Custom', reason: 'unconvertible:custom_condition', policyId: null, policyName: null,
    retiredAt: '2026-11-01T00:00:00.000Z' }], sweep: null };
  h.report.mockResolvedValue(report);
  const res = await request();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: { policies: 0, rows: 0, pendingPolicies: [], ...report } });
  expect(h.report).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG }), ORG);
});
it('returns null for an absent sweep marker', async () => {
  const res = await request();
  expect((await res.json()).data.sweep).toBeNull();
});
it('denies another organization before reading the report', async () => {
  expect((await request(OTHER)).status).toBe(403);
  expect(h.report).not.toHaveBeenCalled();
});

it('rejects an invalid org before calling either loader', async () => {
  expect((await request('not-a-uuid')).status).toBe(400);
  expect(h.counts).not.toHaveBeenCalled();
  expect(h.report).not.toHaveBeenCalled();
});
it.each(['authenticated', 'permitted'] as const)('requires %s access to the report', async (gate) => {
  h[gate] = false;
  expect((await request()).status).toBe(gate === 'authenticated' ? 401 : 403);
  expect(h.counts).not.toHaveBeenCalled();
  expect(h.report).not.toHaveBeenCalled();
});
it('returns server failure instead of silently dropping an unavailable report', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    h.report.mockRejectedValue(new Error('report unavailable'));
    expect((await request()).status).toBe(500);
  } finally { log.mockRestore(); }
});
