import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

const m = vi.hoisted(() => ({ stats: vi.fn() }));

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
  withDbAccessContext: (_ctx: any, fn: any) => fn(),
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(),
  getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(),
  resolveDeviceContext: vi.fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: vi.fn() }));
vi.mock('./deviceStats', () => ({ queryDeviceStats: m.stats }));

import { registerDeviceTools } from './aiToolsDevice';
import { toolInputSchemas } from './aiToolSchemas';
import { devices } from '../db/schema';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const NAME = 'get_fleet_device_stats';
const ORG = '11111111-1111-4111-8111-111111111111';
const counts = { total: 3, online: 2, offline: 1, byStatus: { online: 2, offline: 1 }, migrationRequiredCount: 0 };

function setup() {
  const tools = new Map<string, AiTool>();
  registerDeviceTools(tools);
  return tools.get(NAME)!;
}
const authFor = (over: Record<string, unknown> = {}) =>
  ({
    scope: 'partner',
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: vi.fn(() => true),
    ...over,
  }) as unknown as AuthContext;

const render = (scope: unknown) => new PgDialect().sqlToQuery(scope as any);
const scopeSentTo = () => m.stats.mock.calls[0]![0];

describe(NAME, () => {
  beforeEach(() => {
    m.stats.mockReset();
    m.stats.mockResolvedValue(counts);
  });

  it('is a registered tier-1 devices read', () => {
    expect(setup()).toMatchObject({ tier: 1, domain: 'devices' });
  });

  it('returns the shared exact counts', async () => {
    const out = JSON.parse(await setup().handler({}, authFor()));
    expect(out).toEqual(counts);
    expect(m.stats).toHaveBeenCalledTimes(1);
  });

  it('denies an inaccessible orgId without querying', async () => {
    const auth = authFor({ canAccessOrg: vi.fn(() => false) });
    const out = JSON.parse(await setup().handler({ orgId: ORG }, auth));
    expect(out.error).toMatch(/denied/i);
    expect(m.stats).not.toHaveBeenCalled();
  });

  it('validates input', () => {
    const schema = toolInputSchemas[NAME]!;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ orgId: ORG }).success).toBe(true);
    expect(schema.safeParse({ orgId: 'nope' }).success).toBe(false);
  });

  it('narrows to the requested org', async () => {
    await setup().handler({ orgId: ORG }, authFor());
    const q = render(scopeSentTo());
    expect(q.sql).toContain('"org_id"');
    expect(q.params).toContain(ORG);
  });

  it('applies the caller org condition', async () => {
    const auth = authFor({ orgCondition: vi.fn(() => eq(devices.orgId, ORG)) });
    await setup().handler({}, auth);
    expect(render(scopeSentTo()).params).toContain(ORG);
  });

  it('narrows a site-restricted caller to its allowed sites', async () => {
    await setup().handler({}, authFor({ allowedSiteIds: ['site-a'] }));
    const q = render(scopeSentTo());
    expect(q.sql).toContain('"site_id"');
    expect(q.params).toContain('site-a');
  });

  it('narrows a device-bound run to its frozen device set', async () => {
    await setup().handler({}, authFor({ allowedDeviceIds: ['dev-1'] }));
    const q = render(scopeSentTo());
    expect(q.sql).toContain('"id" in');
    expect(q.params).toContain('dev-1');
  });

  it('denies all devices for an empty site allowlist (no leak)', async () => {
    await setup().handler({}, authFor({ allowedSiteIds: [] }));
    expect(render(scopeSentTo()).sql).toMatch(/false/);
  });

  it('passes no narrowing for an unrestricted caller', async () => {
    await setup().handler({}, authFor());
    expect(scopeSentTo()).toBeUndefined();
  });
});
