import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(), getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(), resolveDeviceContext: vi.fn(),
}));

describe('custom field definition query extraction', () => {
  it('exports the dual-axis definition reader and its predicate builder', async () => {
    const mod = await import('./aiToolsDevice');
    expect(typeof mod.readCustomFieldDefinitions).toBe('function');
    expect(typeof mod.customFieldDefinitionConditions).toBe('function');
  });

  it('builds one predicate per axis so partner-wide definitions survive', async () => {
    // org axis + partner axis = two OR-ed predicates; an org-only `eq` would be one.
    const { customFieldDefinitionConditions } = await import('./aiToolsDevice');
    expect(customFieldDefinitionConditions({ orgId: 'org-1', partnerId: 'p-1' } as never)).toHaveLength(2);
    expect(customFieldDefinitionConditions({ orgId: 'org-1' } as never)).toHaveLength(1);
  });
});
