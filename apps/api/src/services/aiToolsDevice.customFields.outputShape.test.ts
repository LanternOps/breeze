// #6734 (A-W05 D12b follow-up): query_custom_fields returned every definition
// (and, for get_device_values, the device's whole value map) in one response.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  let rows: unknown[] = [];
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }) }));
  return { select, setRows: (r: unknown[]) => { rows = r; } };
});
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock,
}));
const access = vi.hoisted(() => ({ verifyDeviceAccess: vi.fn() }));
vi.mock('./aiTools', () => access);
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(), getAllDeviceContext: vi.fn(), createDeviceContext: vi.fn(), resolveDeviceContext: vi.fn(),
}));

import { registerDeviceTools } from './aiToolsDevice';
import { toolInputSchemas } from './aiToolSchemas';
import type { AiTool } from './aiTools';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const auth = { user: { id: 'u1' }, scope: 'organization', orgId: 'org-1', partnerId: 'p1', accessibleOrgIds: ['org-1'] } as never;
const reg = new Map<string, AiTool>();
registerDeviceTools(reg);
const tool = reg.get('query_custom_fields')!;
const call = async (input: Record<string, unknown>) => JSON.parse(await tool.handler(input, auth));

function definition(i: number) {
  return {
    id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
    name: `Backup retention class ${i}`, fieldKey: `backup_retention_class_${i}`, type: 'select', required: i % 3 === 0,
    options: { choices: ['bronze-30d', 'silver-90d', 'gold-1y', 'platinum-7y', 'legal-hold', 'none'] },
    deviceTypes: ['windows', 'macos'], defaultValue: 'silver-90d',
  };
}
const ALL = Array.from({ length: 120 }, (_, i) => definition(i));

describe('query_custom_fields output shape (#6734)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.setRows(ALL);
    access.verifyDeviceAccess.mockResolvedValue({
      device: {
        id: DEVICE_ID, hostname: 'WKSTN-ACCOUNTING-7',
        customFields: { ...Object.fromEntries(ALL.map((d, i) => [d.fieldKey, i % 2 ? 'gold-1y' : 'bronze-30d'])), orphan_key: 'kept-out' },
      },
    });
  });

  it('declares limit/offset/cursor with the shared text on the registry and Zod surfaces', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 15, max 100)');
    expect(props.cursor).toBeDefined();
    expect(toolInputSchemas.query_custom_fields!.safeParse({ action: 'list_definitions', limit: 5, offset: 0, cursor: 'x' }).success).toBe(true);
  });

  it('list_definitions: a default page fits the chat budget uncompacted and carries the envelope', async () => {
    const raw = await tool.handler({ action: 'list_definitions' }, auth);
    expectDefaultPageFits('query_custom_fields', raw);
    const out = JSON.parse(raw);
    expect(out).toMatchObject({ showing: 15, limit: 15, offset: 0, total: 120, hasMore: true });
    expect(out.definitions[0]).toMatchObject({ fieldKey: 'backup_retention_class_0', options: ALL[0]!.options });
  });

  it('list_definitions: following nextCursor returns every definition exactly once', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const out = await call({ action: 'list_definitions', ...(cursor ? { cursor } : {}) });
      seen.push(...out.definitions.map((d: { id: string }) => d.id));
      if (!out.hasMore) { expect(out.nextCursor).toBeNull(); break; }
      cursor = out.nextCursor;
    }
    expect(seen).toEqual(ALL.map((d) => d.id));
  });

  it('get_device_values: pages the definitions and returns only that page\'s values', async () => {
    const raw = await tool.handler({ action: 'get_device_values', deviceId: DEVICE_ID }, auth);
    expectDefaultPageFits('query_custom_fields', raw);
    const out = JSON.parse(raw);
    expect(out).toMatchObject({ deviceId: DEVICE_ID, hostname: 'WKSTN-ACCOUNTING-7', showing: 15, total: 120, hasMore: true });
    expect(Object.keys(out.customFields)).toEqual(out.definitions.map((d: { fieldKey: string }) => d.fieldKey));
    expect(out.customFields).not.toHaveProperty('orphan_key');
  });

  it('refuses a cursor replayed across actions', async () => {
    const first = await call({ action: 'list_definitions' });
    expect(await call({ action: 'get_device_values', deviceId: DEVICE_ID, cursor: first.nextCursor })).toMatchObject({ code: 'CURSOR_MISMATCH' });
  });
});
