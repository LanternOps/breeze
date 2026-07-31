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
    partnerId: 'patchPolicies.partnerId',
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

const PARTNER_ID = '00000000-0000-0000-0000-000000000001';
const RING_ID = '22222222-2222-2222-2222-222222222222';
const ORG_ID = '33333333-3333-3333-3333-333333333333';
const BACKUP_CONFIG_ID = '44444444-4444-4444-4444-444444444444';

function makeAuth() {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'partner',
    partnerId: PARTNER_ID,
    orgId: null,
    accessibleOrgIds: [],
    canAccessOrg: () => false,
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

function getBackupConfigsTool() {
  const tools = new Map<string, any>();
  registerPolicyPrereqTools(tools);
  const tool = tools.get('manage_backup_configs');
  if (!tool) throw new Error('manage_backup_configs tool not registered');
  return tool;
}

function makeOrgAuth() {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    scope: 'organization',
    partnerId: null,
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: () => true,
    orgCondition: () => undefined,
  } as any;
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
    mockSelectReturns({ id: RING_ID, partnerId: PARTNER_ID, name: 'Ring A', kind: 'ring' });
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
    mockSelectReturns({ id: RING_ID, partnerId: PARTNER_ID, name: 'Ring A', kind: 'ring' });
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

  it('rejects create and other actions for org-scope callers', async () => {
    const tool = getTool();
    const orgAuth = {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as any;

    for (const action of ['list', 'get', 'create', 'update']) {
      const output = await tool.handler({ action, ringId: RING_ID, name: 'X' }, orgAuth);
      const parsed = JSON.parse(output);
      expect(parsed.error).toMatch(/partner scope/i);
    }
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('create writes partnerId (not orgId) when called with partner scope', async () => {
    mockInsertReturns({ id: RING_ID, name: 'Ring B' });
    const tool = getTool();
    const output = await tool.handler(
      { action: 'create', name: 'Ring B' },
      makeAuth()
    );

    expect(JSON.parse(output).success).toBe(true);
    const written = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(written.partnerId).toBe(PARTNER_ID);
    expect(written.orgId).toBeUndefined();
  });
});

// manage_backup_configs used to write `providerConfig` straight to the DB,
// bypassing the REST routes' S3 endpoint validation entirely — the one
// remaining save-time hole in Sentry BREEZE-P. These tests cover routing it
// through the same validateS3Details helper the REST routes use.
describe('manage_backup_configs S3 endpoint validation (Sentry BREEZE-P residual gap)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects create with a genuinely malformed S3 endpoint and does NOT write', async () => {
    const tool = getBackupConfigsTool();
    const output = await tool.handler(
      {
        action: 'create',
        name: 'S3 backup',
        type: 'file',
        provider: 's3',
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 'not a valid url with spaces',
        },
      },
      makeOrgAuth()
    );

    const parsed = JSON.parse(output);
    expect(parsed.error).toMatch(/not a valid URL/i);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('persists the normalized endpoint on create, not the raw scheme-less value', async () => {
    mockInsertReturns({ id: BACKUP_CONFIG_ID, name: 'S3 backup' });
    const tool = getBackupConfigsTool();
    const output = await tool.handler(
      {
        action: 'create',
        name: 'S3 backup',
        type: 'file',
        provider: 's3',
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 'minio.internal.example.com:9000',
        },
      },
      makeOrgAuth()
    );

    expect(JSON.parse(output).success).toBe(true);
    const written = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(written.providerConfig.endpoint).toBe('https://minio.internal.example.com:9000/');
  });

  it('does not persist a blank endpoint string on create (Sentry BREEZE-P gap (b))', async () => {
    mockInsertReturns({ id: BACKUP_CONFIG_ID, name: 'S3 backup' });
    const tool = getBackupConfigsTool();
    const output = await tool.handler(
      {
        action: 'create',
        name: 'S3 backup',
        type: 'file',
        provider: 's3',
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: '',
        },
      },
      makeOrgAuth()
    );

    expect(JSON.parse(output).success).toBe(true);
    const written = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(written.providerConfig).not.toHaveProperty('endpoint');
  });

  it('rejects update with a malformed S3 endpoint and does NOT write', async () => {
    mockSelectReturns({
      id: BACKUP_CONFIG_ID,
      orgId: ORG_ID,
      name: 'S3 backup',
      provider: 's3',
      providerConfig: { bucket: 'backups', region: 'us-east-1' },
    });
    const tool = getBackupConfigsTool();
    const output = await tool.handler(
      {
        action: 'update',
        configId: BACKUP_CONFIG_ID,
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 'not a valid url with spaces',
        },
      },
      makeOrgAuth()
    );

    const parsed = JSON.parse(output);
    expect(parsed.error).toMatch(/not a valid URL/i);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('persists the normalized endpoint on update, not the raw scheme-less value', async () => {
    mockSelectReturns({
      id: BACKUP_CONFIG_ID,
      orgId: ORG_ID,
      name: 'S3 backup',
      provider: 's3',
      providerConfig: { bucket: 'backups', region: 'us-east-1' },
    });
    mockUpdate();
    const tool = getBackupConfigsTool();
    const output = await tool.handler(
      {
        action: 'update',
        configId: BACKUP_CONFIG_ID,
        providerConfig: {
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'key',
          secretKey: 'secret',
          endpoint: 'minio.internal.example.com:9000',
        },
      },
      makeOrgAuth()
    );

    expect(JSON.parse(output).success).toBe(true);
    const setArg = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(setArg.providerConfig.endpoint).toBe('https://minio.internal.example.com:9000/');
  });
});
