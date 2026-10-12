import { describe, expect, it, vi } from 'vitest';

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

describe(NAME, () => {
  it('is a registered tier-1 devices read', () => {
    expect(setup()).toMatchObject({ tier: 1, domain: 'devices' });
  });

  it('returns the shared exact counts, scoped by the caller', async () => {
    m.stats.mockResolvedValue(counts);
    const auth = authFor();
    const out = JSON.parse(await setup().handler({}, auth));
    expect(out).toEqual(counts);
    expect(auth.orgCondition).toHaveBeenCalled();
    expect(m.stats).toHaveBeenCalledTimes(1);
  });

  it('denies an inaccessible orgId without querying', async () => {
    m.stats.mockClear();
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
});
