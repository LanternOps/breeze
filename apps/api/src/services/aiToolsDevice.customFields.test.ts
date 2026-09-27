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
  // 15s: this dynamically imports the real aiTools.ts registry (only ../db and
  // ./brainDeviceContext are mocked), which now fully resolves rather than
  // short-circuiting on the aiToolsDevice<->aiTools<->aiToolsExportDatasets
  // cycle (fixed via lazy imports in aiToolsExportDatasets.ts) — loading every
  // real registerXTools module can exceed the default 5s timeout.
  it('exports the dual-axis definition reader and its predicate builder', async () => {
    const mod = await import('./aiToolsDevice');
    expect(typeof mod.readCustomFieldDefinitions).toBe('function');
    expect(typeof mod.customFieldDefinitionConditions).toBe('function');
  }, 15000);

  it('builds one predicate per axis so partner-wide definitions survive', async () => {
    // org axis + partner axis = two OR-ed predicates; an org-only `eq` would be one.
    const { customFieldDefinitionConditions } = await import('./aiToolsDevice');
    expect(customFieldDefinitionConditions({ orgId: 'org-1', partnerId: 'p-1' } as never)).toHaveLength(2);
    expect(customFieldDefinitionConditions({ orgId: 'org-1' } as never)).toHaveLength(1);
  });

  /** Renders a drizzle SQL fragment's literal text + inline param values, for assertion only. */
  function renderSql(cond: unknown): string {
    return (cond as { queryChunks: unknown[] }).queryChunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (Array.isArray(chunk)) return JSON.stringify(chunk);
        const value = (chunk as { value?: unknown }).value;
        if (value !== undefined) return JSON.stringify(value);
        return `<${(chunk as { constructor?: { name?: string } })?.constructor?.name ?? '?'}>`;
      })
      .join('');
  }

  it('partner-scope caller (no direct org) restricts org-owned definitions to their accessible orgs, matching routes/customFields.ts:238-249', async () => {
    const { customFieldDefinitionConditions } = await import('./aiToolsDevice');
    const conditions = customFieldDefinitionConditions({
      orgId: null,
      partnerId: 'p-1',
      accessibleOrgIds: ['org-A'],
    } as never);
    const rendered = conditions.map(renderSql).join(' AND ');

    // Must scope org-owned rows to the partner's accessible orgs...
    expect(rendered).toContain('org-A');
    // ...never fall back to "partnerId IS NULL", which matches every org-owned
    // definition system-wide and leaves RLS as the only gate.
    expect(rendered).not.toMatch(/partner_id.*IS NULL/i);
  });
});
