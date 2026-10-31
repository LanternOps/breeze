// apps/api/src/services/aiToolsPartnerSettingsInheritance.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The tool is a thin twin of routes/partnerSettingsInheritance.ts: it calls the
// SAME service functions (which own the query budget and the secret
// projection), so the services are mocked here and the tool's own job — the
// gate, input validation, error mapping — is what is under test.
const svc = vi.hoisted(() => ({ aggregateTab: vi.fn(), listFieldOrgs: vi.fn() }));
vi.mock('./partnerSettingsInheritance/aggregate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./partnerSettingsInheritance/aggregate')>();
  return { ...actual, aggregateTab: svc.aggregateTab };
});
vi.mock('./partnerSettingsInheritance/drilldown', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./partnerSettingsInheritance/drilldown')>();
  return { ...actual, listFieldOrgs: svc.listFieldOrgs };
});
vi.mock('../db', () => ({ db: {}, runOutsideDbContext: <T,>(fn: () => T): T => fn(), withSystemDbAccessContext: <T,>(fn: () => T): T => fn() }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('./sentry', () => sentry);

import { PARTNER_SETTINGS_CATALOG } from '@breeze/shared';
import { registerPartnerSettingsInheritanceTools } from './aiToolsPartnerSettingsInheritance';
import { InheritanceBadRequest, InheritanceNotFound } from './partnerSettingsInheritance/aggregate';
import { PARTNER_WIDE_READ_DENIED_MESSAGE } from './partnerWideAccess';
import { BUCKETS } from './partnerSettingsInheritance/bindings';
import { DRILLDOWN_MAX_LIMIT } from './partnerSettingsInheritance/drilldown';
import {
  PARTNER_SETTINGS_INHERITANCE_BUCKETS,
  PARTNER_SETTINGS_INHERITANCE_MAX_LIMIT,
  validateToolInput,
} from './aiToolSchemas';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const PARTNER = '33333333-3333-4333-8333-333333333333';
const ORG_1 = '11111111-1111-4111-8111-111111111111';
const ORG_2 = '22222222-2222-4222-8222-222222222222';
const TOOL = 'get_partner_settings_inheritance';
const tools = new Map<string, AiTool>();
registerPartnerSettingsInheritanceTools(tools);
const tool = tools.get(TOOL)!;

const fullPartner = (over: Partial<AuthContext> = {}) => ({
  scope: 'partner',
  partnerId: PARTNER,
  orgId: null,
  partnerOrgAccess: 'all',
  accessibleOrgIds: [ORG_1, ORG_2],
  canAccessOrg: () => true,
  ...over,
}) as unknown as AuthContext;
const run = async (input: Record<string, unknown>, a = fullPartner()) => JSON.parse(await tool.handler(input, a));
const FIELD = PARTNER_SETTINGS_CATALOG.find((e) => e.kind === 'overridable')!.id;

describe(TOOL, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.aggregateTab.mockResolvedValue({ tab: 'regional', orgCount: 2, fields: [] });
    svc.listFieldOrgs.mockResolvedValue({ field: FIELD, rows: [], nextCursor: null });
  });

  it('is a tier-1 read with a bounded description and no device arguments', () => {
    expect(tool).toBeDefined();
    expect(tool.tier).toBe(1);
    expect(tool.deviceArgs).toEqual([]);
    expect(tool.definition.description!.length).toBeLessThanOrEqual(300);
    const schema = tool.definition.input_schema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(['bucket', 'cursor', 'field', 'limit', 'tab']);
  });

  it('the input schema mirrors the service\'s buckets and page cap', () => {
    expect([...PARTNER_SETTINGS_INHERITANCE_BUCKETS]).toEqual([...BUCKETS]);
    expect(PARTNER_SETTINGS_INHERITANCE_MAX_LIMIT).toBe(DRILLDOWN_MAX_LIMIT);
  });

  it('dispatch validation uses the same schema (validateToolInput)', () => {
    expect(validateToolInput(TOOL, { tab: 'regional' })).toEqual({ success: true });
    expect(validateToolInput(TOOL, { field: FIELD, bucket: 'overrides', limit: 5 })).toEqual({ success: true });
    expect(validateToolInput(TOOL, { tab: 'regional', field: FIELD }).success).toBe(false);
    expect(validateToolInput(TOOL, { field: FIELD, extra: 1 }).success).toBe(false);
  });

  describe('gate (the routes\': partner scope + partner context + full partner org access)', () => {
    it.each([
      ['an organization-scope caller', { scope: 'organization', orgId: ORG_1, partnerOrgAccess: undefined }],
      ['system scope (the routes exclude it with requireScope("partner"))', { scope: 'system', partnerOrgAccess: undefined }],
      ['a partner caller with no partner context', { partnerId: null }],
      ['a selected-access partner user, even one whose selection covers every org', { partnerOrgAccess: 'selected' }],
      ['an MCP key / context that never resolved a partner membership', { partnerOrgAccess: undefined }],
      ['a device-restricted run', { allowedDeviceIds: [] }],
    ])('refuses %s without reading', async (_label, over) => {
      const out = await run({ tab: 'regional' }, fullPartner(over as Partial<AuthContext>));
      expect(out.error).toBeTruthy();
      expect(svc.aggregateTab).not.toHaveBeenCalled();
      const outField = await run({ field: FIELD }, fullPartner(over as Partial<AuthContext>));
      expect(outField.error).toBeTruthy();
      expect(svc.listFieldOrgs).not.toHaveBeenCalled();
    });

    it('a selected-access partner user gets the routes\' read-denied message', async () => {
      const out = await run({ tab: 'regional' }, fullPartner({ partnerOrgAccess: 'selected' } as Partial<AuthContext>));
      expect(out.error).toBe(PARTNER_WIDE_READ_DENIED_MESSAGE);
      expect(out.code).toBe('PARTNER_WIDE_REQUIRED');
    });
  });

  describe('tab summary', () => {
    it('reads the tab counts in the caller\'s partner and org list', async () => {
      const out = await run({ tab: 'regional' });
      expect(svc.aggregateTab).toHaveBeenCalledWith('regional', { partnerId: PARTNER, accessibleOrgIds: [ORG_1, ORG_2] });
      expect(out).toEqual({ data: { tab: 'regional', orgCount: 2, fields: [] } });
    });

    it('rejects an unknown tab', async () => {
      const out = await run({ tab: 'nope' });
      expect(out.error).toMatch(/tab/);
      expect(svc.aggregateTab).not.toHaveBeenCalled();
    });

    it('requires exactly one of tab or field', async () => {
      expect((await run({})).error).toBeTruthy();
      expect((await run({ tab: 'regional', field: FIELD })).error).toBeTruthy();
      expect(svc.aggregateTab).not.toHaveBeenCalled();
      expect(svc.listFieldOrgs).not.toHaveBeenCalled();
    });

    it('drill-down arguments are refused with a tab', async () => {
      const out = await run({ tab: 'regional', bucket: 'overrides' });
      expect(out.error).toBeTruthy();
      expect(svc.aggregateTab).not.toHaveBeenCalled();
    });
  });

  describe('field drill-down', () => {
    it('defaults to the ownValue bucket and the route\'s page size', async () => {
      const out = await run({ field: FIELD });
      expect(svc.listFieldOrgs).toHaveBeenCalledWith(
        FIELD,
        { partnerId: PARTNER, accessibleOrgIds: [ORG_1, ORG_2] },
        { bucket: 'ownValue', cursor: null, limit: 50 },
      );
      expect(out).toEqual({ data: { field: FIELD, rows: [], nextCursor: null } });
    });

    it('passes bucket, cursor and limit through', async () => {
      await run({ field: FIELD, bucket: 'overrides', cursor: 'abc_-1', limit: 10 });
      expect(svc.listFieldOrgs).toHaveBeenCalledWith(FIELD, expect.anything(), { bucket: 'overrides', cursor: 'abc_-1', limit: 10 });
    });

    it.each([
      ['an unknown field', { field: 'not.a.setting' }],
      ['an inherited object key as a field', { field: 'constructor' }],
      ['an unknown bucket', { field: FIELD, bucket: 'everything' }],
      ['a malformed cursor', { field: FIELD, cursor: 'not base64url!' }],
      ['a limit over the page cap', { field: FIELD, limit: 51 }],
      ['a zero limit', { field: FIELD, limit: 0 }],
    ])('rejects %s before reading', async (_label, input) => {
      const out = await run(input);
      expect(out.error).toBeTruthy();
      expect(svc.listFieldOrgs).not.toHaveBeenCalled();
    });

    it('maps the service\'s known errors to their messages', async () => {
      svc.listFieldOrgs.mockRejectedValueOnce(new InheritanceBadRequest('This setting has no org-level value'));
      expect((await run({ field: FIELD })).error).toBe('This setting has no org-level value');
      svc.listFieldOrgs.mockRejectedValueOnce(new InheritanceNotFound('Partner not found'));
      expect((await run({ field: FIELD })).error).toBe('Partner not found');
      expect(sentry.captureException).not.toHaveBeenCalled();
    });

    it('an unexpected failure returns a generic error and is reported', async () => {
      svc.listFieldOrgs.mockRejectedValueOnce(new Error('connection reset: secret detail'));
      const out = await run({ field: FIELD });
      expect(out.error).not.toMatch(/secret detail/);
      expect(sentry.captureException).toHaveBeenCalledTimes(1);
    });
  });
});
