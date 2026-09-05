import { beforeEach, describe, expect, it, vi } from 'vitest';

// db is mocked so the handler never touches Postgres. The insert/update mocks
// double as spies that assert we never WRITE a fail-open autoApprove shape.
const { insertMock, updateMock, selectMock, resolvePolicyDeviceIdsMock, schedulePolicyDevicesMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  selectMock: vi.fn(),
  resolvePolicyDeviceIdsMock: vi.fn().mockResolvedValue(['device-1']),
  schedulePolicyDevicesMock: vi.fn().mockResolvedValue(['job-1']),
}));

vi.mock('../jobs/peripheralJobs', () => ({
  resolvePeripheralPolicyDeviceIds: resolvePolicyDeviceIdsMock,
  schedulePeripheralPolicyDevices: schedulePolicyDevicesMock,
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
  },
}));
vi.mock('../db/schema/softwarePolicies', () => ({ softwarePolicies: {} }));
// Cut the audit helper's transitive pull on the full schema barrel (#3543).
// Audit-fan-out behaviour is covered by aiToolsPolicyPrereqs.softwarePolicyAudit.test.ts.
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
}));
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
    partnerOrgAccess: 'all',
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

  it('update with an old-shape autoApprove preserves the stored third-party opt-in (merge, not replace)', async () => {
    // The model routinely writes partial objects for fields it wasn't asked
    // about — an omitted thirdPartyApps must not reset the ring's opt-in.
    mockSelectReturns({
      id: RING_ID,
      partnerId: PARTNER_ID,
      name: 'Ring A',
      kind: 'ring',
      autoApprove: { enabled: true, severities: ['critical'], deferralDays: 0, thirdPartyApps: true, thirdPartyDeferralDays: 12 },
    });
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
    const setArg = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(setArg.autoApprove).toEqual({
      enabled: true,
      severities: ['low'],
      deferralDays: 0,
      thirdPartyApps: true,
      thirdPartyDeferralDays: 12,
      autoApproveUnrated: false,
    });
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

  it('manage_update_rings create accepts a third-party-only autoApprove', async () => {
    mockInsertReturns({ id: RING_ID, name: 'Ring A' });
    const tool = getTool();
    const output = await tool.handler(
      {
        action: 'create',
        name: 'Ring A',
        autoApprove: { enabled: true, severities: [], thirdPartyApps: true },
      },
      makeAuth()
    );

    const parsed = JSON.parse(output);
    expect(parsed.error).toBeUndefined();
    expect(parsed.success).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const written = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(written.autoApprove).toMatchObject({
      enabled: true,
      severities: [],
      thirdPartyApps: true,
    });
  });

  it('manage_update_rings create/update ignore a sources input and never write the column', async () => {
    mockInsertReturns({ id: RING_ID, name: 'Ring A' });
    const tool = getTool();
    const createOutput = await tool.handler(
      { action: 'create', name: 'Ring A', sources: ['os'] },
      makeAuth()
    );
    expect(JSON.parse(createOutput).success).toBe(true);
    const createdValues = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(createdValues).not.toHaveProperty('sources');

    vi.clearAllMocks();
    mockSelectReturns({ id: RING_ID, partnerId: PARTNER_ID, name: 'Ring A', kind: 'ring' });
    mockUpdate();
    const updateOutput = await tool.handler(
      { action: 'update', ringId: RING_ID, sources: ['os'] },
      makeAuth()
    );
    expect(JSON.parse(updateOutput).success).toBe(true);
    const updatedValues = updateMock.mock.results[0]!.value.set.mock.calls[0][0];
    expect(updatedValues).not.toHaveProperty('sources');
  });

  it('manage_update_rings still rejects enabled with no severities and no thirdPartyApps', async () => {
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
    expect(parsed.error).toMatch(/severity|third-party/i);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('manage_update_rings get returns ring rows without a sources key (column dropped, #3151)', async () => {
    mockSelectReturns({
      id: RING_ID,
      partnerId: PARTNER_ID,
      name: 'Ring A',
      kind: 'ring',
    });
    const tool = getTool();
    const output = await tool.handler({ action: 'get', ringId: RING_ID }, makeAuth());

    const parsed = JSON.parse(output);
    expect(parsed.ring).toBeDefined();
    expect(parsed.ring).not.toHaveProperty('sources');
    expect(parsed.ring.id).toBe(RING_ID);
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

/**
 * `ownerScope: 'partner'` creates a template that applies to EVERY org under
 * the partner, while the tool's RBAC entry only asks for `policies.write` —
 * org-level authority. `canManagePartnerWidePolicies` is the sole thing
 * separating the two, and until #2814 registered these tools nothing could
 * reach the branch, so nothing covered it.
 */
describe('manage_software_policies partner-wide create gate (#2126)', () => {
  beforeEach(() => {
    insertMock.mockReset();
    updateMock.mockReset();
    selectMock.mockReset();
  });

  function getSoftwarePoliciesTool() {
    const tools = new Map<string, any>();
    registerPolicyPrereqTools(tools);
    const tool = tools.get('manage_software_policies');
    if (!tool) throw new Error('manage_software_policies tool not registered');
    return tool;
  }

  const CREATE_INPUT = {
    action: 'create',
    ownerScope: 'partner',
    name: 'Partner Blocklist',
    mode: 'blocklist',
  };

  it('REFUSES a partner-scoped caller without full org access, and writes nothing', async () => {
    const auth = { ...makeAuth(), partnerOrgAccess: 'subset' };
    const output = await getSoftwarePoliciesTool().handler(CREATE_INPUT, auth);

    expect(JSON.parse(output).error).toMatch(/full partner org access/);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('REFUSES an org-scoped caller, and writes nothing', async () => {
    const output = await getSoftwarePoliciesTool().handler(CREATE_INPUT, makeOrgAuth());

    // Asserted on the specific refusal so this cannot pass on an unrelated
    // validation error (missing name/mode) once the gate is gone.
    expect(JSON.parse(output).error).toMatch(/require partner scope/);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('ALLOWS partnerOrgAccess "all" and writes partnerId, never orgId', async () => {
    mockInsertReturns({ id: 'policy-1', name: 'Partner Blocklist', partnerId: PARTNER_ID, orgId: null });
    const auth = { ...makeAuth(), partnerOrgAccess: 'all' };

    const output = await getSoftwarePoliciesTool().handler(CREATE_INPUT, auth);

    expect(JSON.parse(output).error).toBeUndefined();
    const values = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(values.partnerId).toBe(PARTNER_ID);
    expect(values.orgId).toBeNull();
  });

  it('defaults to org ownership when ownerScope is omitted', async () => {
    mockInsertReturns({ id: 'policy-2', name: 'Org Blocklist', orgId: ORG_ID, partnerId: null });

    const output = await getSoftwarePoliciesTool().handler(
      { action: 'create', name: 'Org Blocklist', mode: 'blocklist' },
      makeOrgAuth()
    );

    expect(JSON.parse(output).error).toBeUndefined();
    const values = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    expect(values.orgId).toBe(ORG_ID);
    expect(values.partnerId).toBeNull();
  });
});

/**
 * `manage_peripheral_policies` had no handler coverage at all despite becoming
 * reachable from AI/MCP for the first time in #2814. It also carries the
 * `action_type` rename — the tool takes `action_type` because `action` is the
 * multiplexer — and a silently dropped rename would create the policy with a
 * default enforcement mode while still reporting success.
 */
describe('manage_peripheral_policies create (#2814 — first reachable)', () => {
  beforeEach(() => {
    insertMock.mockReset();
    updateMock.mockReset();
    selectMock.mockReset();
  });

  function getPeripheralPoliciesTool() {
    const tools = new Map<string, any>();
    registerPolicyPrereqTools(tools);
    const tool = tools.get('manage_peripheral_policies');
    if (!tool) throw new Error('manage_peripheral_policies tool not registered');
    return tool;
  }

  it('maps action_type onto the `action` column and scopes the row to the org', async () => {
    mockInsertReturns({ id: 'peripheral-1', name: 'Block USB storage' });

    const output = await getPeripheralPoliciesTool().handler(
      {
        action: 'create',
        name: 'Block USB storage',
        deviceClass: 'storage',
        action_type: 'block',
      },
      makeOrgAuth()
    );

    expect(JSON.parse(output).success).toBe(true);
    const values = insertMock.mock.results[0]!.value.values.mock.calls[0][0];
    // The rename is the whole point: `action` must carry the enforcement mode,
    // never the 'create' multiplexer value.
    expect(values.action).toBe('block');
    expect(values.deviceClass).toBe('storage');
    expect(values.orgId).toBe(ORG_ID);
    expect(schedulePolicyDevicesMock).toHaveBeenCalledWith(['device-1'], 'ai-prereq-create');
  });

  it('refuses to create without action_type rather than defaulting the enforcement mode', async () => {
    const output = await getPeripheralPoliciesTool().handler(
      { action: 'create', name: 'Incomplete', deviceClass: 'storage' },
      makeOrgAuth()
    );

    expect(JSON.parse(output).error).toMatch(/action_type is required/);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('refuses to create without an org context', async () => {
    const output = await getPeripheralPoliciesTool().handler(
      { action: 'create', name: 'No org', deviceClass: 'storage', action_type: 'block' },
      makeAuth()
    );

    expect(JSON.parse(output).error).toMatch(/Organization context required/);
    expect(insertMock).not.toHaveBeenCalled();
  });
});
