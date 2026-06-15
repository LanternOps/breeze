import { beforeEach, describe, expect, it, vi } from 'vitest';

// db is mocked so the handler never touches Postgres. The insert/update mocks
// double as spies that assert we never WRITE a fail-open autoApprove shape.
const { insertMock, updateMock, selectMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  selectMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    insert: insertMock,
    update: updateMock,
    select: selectMock,
  },
}));

vi.mock('../db/schema/patches', () => ({
  patchPolicies: {
    id: 'patchPolicies.id',
    orgId: 'patchPolicies.orgId',
    kind: 'patchPolicies.kind',
    name: 'patchPolicies.name',
    enabled: 'patchPolicies.enabled',
    autoApprove: 'patchPolicies.autoApprove',
    ringOrder: 'patchPolicies.ringOrder',
    createdAt: 'patchPolicies.createdAt',
    description: 'patchPolicies.description',
    deferralDays: 'patchPolicies.deferralDays',
    deadlineDays: 'patchPolicies.deadlineDays',
    gracePeriodHours: 'patchPolicies.gracePeriodHours',
    categories: 'patchPolicies.categories',
    excludeCategories: 'patchPolicies.excludeCategories',
    sources: 'patchPolicies.sources',
  },
}));
vi.mock('../db/schema/softwarePolicies', () => ({ softwarePolicies: {} }));
vi.mock('../db/schema/peripheralControl', () => ({ peripheralPolicies: {} }));
vi.mock('../db/schema/backup', () => ({ backupConfigs: {} }));

import { registerPolicyPrereqTools } from './aiToolsPolicyPrereqs';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const RING_ID = '22222222-2222-2222-2222-222222222222';

function makeAuth() {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'organization',
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: () => undefined,
  } as any;
}

function getTool() {
  const tools = new Map<string, any>();
  registerPolicyPrereqTools(tools);
  const tool = tools.get('manage_update_rings');
  if (!tool) throw new Error('manage_update_rings tool not registered');
  return tool;
}

function mockInsertReturns(row: Record<string, unknown>) {
  insertMock.mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([row]),
    }),
  });
}

function mockSelectReturns(row: Record<string, unknown> | undefined) {
  selectMock.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(row ? [row] : []),
      }),
    }),
  });
}

function mockUpdate() {
  updateMock.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });
}

describe('manage_update_rings autoApprove fail-closed write boundary (#1317)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects create with autoApprove { enabled: true, severities: [] } and does NOT write', async () => {
    const tool = getTool();
    const output = await tool.handler(
      {
        action: 'create',
        name: 'Ring A',
        autoApprove: { enabled: true, severities: [] },
      },
      makeAuth()
    );

    const parsed = JSON.parse(output);
    expect(parsed.error).toMatch(/at least one severity/i);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects create with autoApprove { enabled: true } (severities missing)', async () => {
    const tool = getTool();
    const output = await tool.handler(
      { action: 'create', name: 'Ring A', autoApprove: { enabled: true } },
      makeAuth()
    );

    const parsed = JSON.parse(output);
    expect(parsed.error).toMatch(/at least one severity/i);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects update with autoApprove { enabled: true, severities: [] } and does NOT write', async () => {
    mockSelectReturns({ id: RING_ID, orgId: ORG_ID, name: 'Ring A', kind: 'ring' });
    mockUpdate();
    const tool = getTool();
    const output = await tool.handler(
      {
        action: 'update',
        ringId: RING_ID,
        autoApprove: { enabled: true, severities: [] },
      },
      makeAuth()
    );

    const parsed = JSON.parse(output);
    expect(parsed.error).toMatch(/at least one severity/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('accepts create with an enabled rule that lists at least one severity', async () => {
    mockInsertReturns({ id: RING_ID, name: 'Ring A' });
    const tool = getTool();
    const output = await tool.handler(
      {
        action: 'create',
        name: 'Ring A',
        autoApprove: { enabled: true, severities: ['critical', 'important'] },
      },
      makeAuth()
    );

    const parsed = JSON.parse(output);
    expect(parsed.success).toBe(true);
    expect(parsed.ringId).toBe(RING_ID);
    expect(insertMock).toHaveBeenCalledTimes(1);
    // The normalized autoApprove (with defaults filled) is what gets written.
    const written = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(written.autoApprove).toMatchObject({
      enabled: true,
      severities: ['critical', 'important'],
      deferralDays: 0,
    });
  });

  it('accepts create with a disabled rule and empty severities (auto-approve nothing)', async () => {
    mockInsertReturns({ id: RING_ID, name: 'Ring A' });
    const tool = getTool();
    const output = await tool.handler(
      {
        action: 'create',
        name: 'Ring A',
        autoApprove: { enabled: false, severities: [] },
      },
      makeAuth()
    );

    expect(JSON.parse(output).success).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const written = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(written.autoApprove).toMatchObject({ enabled: false, severities: [] });
  });

  it('defaults autoApprove to {} when omitted on create', async () => {
    mockInsertReturns({ id: RING_ID, name: 'Ring A' });
    const tool = getTool();
    const output = await tool.handler(
      { action: 'create', name: 'Ring A' },
      makeAuth()
    );

    expect(JSON.parse(output).success).toBe(true);
    const written = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(written.autoApprove).toEqual({});
  });

  it('rejects create with an unknown severity value', async () => {
    const tool = getTool();
    const output = await tool.handler(
      {
        action: 'create',
        name: 'Ring A',
        autoApprove: { enabled: true, severities: ['catastrophic'] },
      },
      makeAuth()
    );

    expect(JSON.parse(output).error).toBeTruthy();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('accepts a valid enabled update and writes the normalized autoApprove', async () => {
    mockSelectReturns({ id: RING_ID, orgId: ORG_ID, name: 'Ring A', kind: 'ring' });
    mockUpdate();
    const tool = getTool();
    const output = await tool.handler(
      {
        action: 'update',
        ringId: RING_ID,
        autoApprove: { enabled: true, severities: ['low'] },
      },
      makeAuth()
    );

    expect(JSON.parse(output).success).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    const setArg = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(setArg.autoApprove).toMatchObject({ enabled: true, severities: ['low'] });
  });
});
