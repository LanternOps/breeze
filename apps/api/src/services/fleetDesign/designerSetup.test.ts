import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  resolveEffectiveAgentMock,
  createAgentMock,
  updateAgentMock,
  getAgentMock,
  selectMock,
  envFlagMock,
} = vi.hoisted(() => ({
  resolveEffectiveAgentMock: vi.fn(),
  createAgentMock: vi.fn(),
  updateAgentMock: vi.fn(),
  getAgentMock: vi.fn(),
  selectMock: vi.fn(),
  envFlagMock: vi.fn(() => true),
}));

// Whole-module mocks (no importOriginal): agentService transitively imports
// the command queue, dispatch, event bus, … — none of which this unit needs.
vi.mock('../aiAgents/effectivePolicy', () => ({
  resolveEffectiveAgent: resolveEffectiveAgentMock,
  normalizeAgentPolicy: (row: { recipients: unknown }) => ({ recipients: row.recipients ?? {} }),
}));
vi.mock('../aiAgents/agentService', () => ({
  createAgent: createAgentMock,
  updateAgent: updateAgentMock,
  getAgent: getAgentMock,
  // Same shapes as the real classes (agentService.ts) — only identity matters
  // for the `instanceof` translation under test.
  AgentKindConflictError: class AgentKindConflictError extends Error { readonly code = 'agent_kind_exists'; },
  ActPrerequisitesNotMetError: class ActPrerequisitesNotMetError extends Error {
    readonly code = 'act_prerequisites_not_met';
    constructor(public missing: string[]) { super('act_prerequisites_not_met'); }
  },
}));
vi.mock('../../config/env', () => ({ envFlag: envFlagMock }));
vi.mock('../../db', () => ({ db: { select: selectMock } }));

const { describeDesignerSetup, enableDesigner, DesignerEnableError } = await import('./designerSetup');
const { ActPrerequisitesNotMetError, AgentKindConflictError } = await import('../aiAgents/agentService');
const { AgentAccessDeniedError } = await import('../aiAgents/access');
const { InvalidAgentRecipientsError } = await import('../aiAgents/recipients');

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const PARTNER_AGENT_ID = '55555555-5555-4555-8555-555555555555';
const ORG_AGENT_ID = '66666666-6666-4666-8666-666666666666';

function selectChain<T>(rows: T) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function partnerAdminAuth(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'partner',
    partnerId: PARTNER_ID,
    partnerOrgAccess: 'all',
    orgId: null,
    user: { id: USER_ID },
    principal: { kind: 'user', id: USER_ID },
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    ...overrides,
  } as never;
}

function orgAuth() {
  return partnerAdminAuth({ scope: 'organization', partnerOrgAccess: 'none', orgId: ORG_ID });
}

function resolved(overrides: { enabled?: boolean; mode?: string; provenance?: Record<string, string> } = {}) {
  return {
    agentId: PARTNER_AGENT_ID,
    kind: 'designer',
    effective: { enabled: overrides.enabled ?? true, mode: overrides.mode ?? 'act' },
    provenance: { enabled: 'partner', mode: 'partner', ...(overrides.provenance ?? {}) },
  };
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PARTNER_AGENT_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    kind: 'designer',
    enabled: false,
    mode: 'off',
    recipients: { userIds: [], roleIds: [] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  envFlagMock.mockReturnValue(true);
  selectMock.mockReturnValue(selectChain([]));
});

describe('describeDesignerSetup', () => {
  it('reports missing + canEnable for a partner admin when no designer resolves', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    await expect(describeDesignerSetup(partnerAdminAuth(), ORG_ID)).resolves.toEqual({
      status: 'missing',
      agentId: null,
      canEnable: true,
    });
  });

  it('reports missing but NOT enableable for an org-scoped token (needs a partner baseline)', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    await expect(describeDesignerSetup(orgAuth(), ORG_ID)).resolves.toMatchObject({ status: 'missing', canEnable: false });
  });

  it('reports ready when the effective agent is enabled and in act', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(resolved());
    await expect(describeDesignerSetup(orgAuth(), ORG_ID)).resolves.toEqual({
      status: 'ready',
      agentId: PARTNER_AGENT_ID,
      canEnable: false,
    });
  });

  it('reports kill_switch_off (never enableable) when BREEZE_AI_AGENTS_ENABLED is off', async () => {
    envFlagMock.mockReturnValue(false);
    resolveEffectiveAgentMock.mockResolvedValue(resolved({ enabled: false }));
    await expect(describeDesignerSetup(partnerAdminAuth(), ORG_ID)).resolves.toMatchObject({ status: 'kill_switch_off', canEnable: false });
  });

  it('reports off; an org token can fix it only when the org row is what turned it off', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(resolved({ mode: 'off', provenance: { mode: 'org' } }));
    await expect(describeDesignerSetup(orgAuth(), ORG_ID)).resolves.toMatchObject({ status: 'off', canEnable: true });

    resolveEffectiveAgentMock.mockResolvedValue(resolved({ mode: 'off', provenance: { mode: 'partner' } }));
    await expect(describeDesignerSetup(orgAuth(), ORG_ID)).resolves.toMatchObject({ status: 'off', canEnable: false });
    await expect(describeDesignerSetup(partnerAdminAuth(), ORG_ID)).resolves.toMatchObject({ status: 'off', canEnable: true });
  });

  it('reports kill_switch_off ahead of missing — creating an agent under the switch cannot help', async () => {
    envFlagMock.mockReturnValue(false);
    resolveEffectiveAgentMock.mockResolvedValue(null);
    await expect(describeDesignerSetup(partnerAdminAuth(), ORG_ID)).resolves.toEqual({ status: 'kill_switch_off', agentId: null, canEnable: false });
  });

  it('reports disabled ahead of off', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(resolved({ enabled: false, mode: 'off' }));
    await expect(describeDesignerSetup(partnerAdminAuth(), ORG_ID)).resolves.toMatchObject({ status: 'disabled' });
  });
});

describe('enableDesigner', () => {
  it('creates a partner-wide designer in act, enabled, with the caller as recipient when none resolves', async () => {
    resolveEffectiveAgentMock.mockResolvedValueOnce(null);
    createAgentMock.mockResolvedValue(agentRow({ id: PARTNER_AGENT_ID, enabled: true, mode: 'act' }));

    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).resolves.toEqual({ status: 'ready', agentId: PARTNER_AGENT_ID, canEnable: false });

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    const [, owner, input] = createAgentMock.mock.calls[0]!;
    expect(owner).toEqual({ orgId: null, partnerId: PARTNER_ID });
    expect(input).toMatchObject({
      kind: 'designer',
      name: 'Fleet Designer',
      ownerScope: 'partner',
      mode: 'act',
      enabled: true,
      recipients: { userIds: [USER_ID] },
    });
    expect(updateAgentMock).not.toHaveBeenCalled();
  });

  // D7 (v0.116.0 sweep): describeDesignerSetup's partner-baseline read
  // (readWithPartnerAxisVisibility) escapes to a SECOND pooled connection —
  // it cannot see the row `createAgent` just wrote inside the request's own
  // still-open transaction, so a stale re-read after create reported
  // {status:"missing", agentId:null}. The create branch must report state
  // from the row it just wrote, not from a fresh cross-connection read.
  it('reports ready from the just-created row even when a stale re-read would still say missing (sweep D7)', async () => {
    resolveEffectiveAgentMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    createAgentMock.mockResolvedValue(agentRow({ id: PARTNER_AGENT_ID, enabled: true, mode: 'act' }));

    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).resolves.toEqual({ status: 'ready', agentId: PARTNER_AGENT_ID, canEnable: false });
    // Only the pre-create existence check should hit resolveEffectiveAgent —
    // no re-describe after the write.
    expect(resolveEffectiveAgentMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to create for a token with no partner scope', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    await expect(enableDesigner(partnerAdminAuth({ partnerId: null, scope: 'organization' }), ORG_ID))
      .rejects.toMatchObject({ code: 'partner_scope_required' });
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('refuses to create for an org-scoped token even though it carries a partnerId', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    await expect(enableDesigner(orgAuth(), ORG_ID)).rejects.toMatchObject({ code: 'partner_admin_required' });
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('refuses when the platform kill switch is off, touching nothing — with or without an existing agent', async () => {
    envFlagMock.mockReturnValue(false);
    resolveEffectiveAgentMock.mockResolvedValue(resolved({ enabled: false }));
    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).rejects.toMatchObject({ code: 'kill_switch_off' });
    resolveEffectiveAgentMock.mockResolvedValue(null);
    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).rejects.toMatchObject({ code: 'kill_switch_off' });
    expect(updateAgentMock).not.toHaveBeenCalled();
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('keeps a role-only recipient list untouched when turning a row on', async () => {
    resolveEffectiveAgentMock
      .mockResolvedValueOnce(resolved({ mode: 'off', provenance: { mode: 'partner' } }))
      .mockResolvedValueOnce(resolved());
    getAgentMock.mockResolvedValue(agentRow({ recipients: { userIds: [], roleIds: ['role-1'] } }));
    updateAgentMock.mockResolvedValue(agentRow({ enabled: true, mode: 'act' }));

    await enableDesigner(partnerAdminAuth(), ORG_ID);

    expect(updateAgentMock).toHaveBeenCalledWith(expect.anything(), PARTNER_AGENT_ID, { enabled: true, mode: 'act' });
  });

  it('turns on the partner row (adding the caller as recipient when it has none) and an off org override', async () => {
    resolveEffectiveAgentMock
      .mockResolvedValueOnce(resolved({ enabled: false, mode: 'off' }))
      .mockResolvedValueOnce(resolved());
    getAgentMock.mockResolvedValue(agentRow());
    selectMock.mockReturnValue(selectChain([agentRow({ id: ORG_AGENT_ID, orgId: ORG_ID, partnerId: null, enabled: true, mode: 'off', recipients: { userIds: [USER_ID], roleIds: [] } })]));
    updateAgentMock.mockResolvedValue(agentRow({ enabled: true, mode: 'act' }));

    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).resolves.toMatchObject({ status: 'ready' });

    expect(updateAgentMock).toHaveBeenCalledTimes(2);
    // Org row FIRST (the org row already had a recipient: only the switches
    // are touched), partner row second — see enableDesignerInner's ordering note.
    expect(updateAgentMock).toHaveBeenNthCalledWith(1, expect.anything(), ORG_AGENT_ID, { enabled: true, mode: 'act' });
    expect(updateAgentMock).toHaveBeenNthCalledWith(2, expect.anything(), PARTNER_AGENT_ID, {
      enabled: true,
      mode: 'act',
      recipients: { userIds: [USER_ID] },
    });
    expect(createAgentMock).not.toHaveBeenCalled();
  });

  it('never touches the partner-wide row when the org override refuses to turn on', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(resolved({ enabled: false, mode: 'off' }));
    selectMock.mockReturnValue(selectChain([agentRow({ id: ORG_AGENT_ID, orgId: ORG_ID, partnerId: null, enabled: false, mode: 'off' })]));
    updateAgentMock.mockRejectedValueOnce(new ActPrerequisitesNotMetError(['recipient']));

    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).rejects.toMatchObject({ code: 'act_prerequisites_not_met' });

    expect(updateAgentMock).toHaveBeenCalledTimes(1);
    expect(updateAgentMock.mock.calls[0]![1]).toBe(ORG_AGENT_ID);
    expect(getAgentMock).not.toHaveBeenCalled();
  });

  it('leaves a healthy partner row alone and fixes only the org override', async () => {
    resolveEffectiveAgentMock
      .mockResolvedValueOnce(resolved({ mode: 'off', provenance: { mode: 'org' } }))
      .mockResolvedValueOnce(resolved());
    selectMock.mockReturnValue(selectChain([agentRow({ id: ORG_AGENT_ID, orgId: ORG_ID, partnerId: null, enabled: true, mode: 'off', recipients: { userIds: [USER_ID], roleIds: [] } })]));
    updateAgentMock.mockResolvedValue(agentRow({ id: ORG_AGENT_ID, enabled: true, mode: 'act' }));

    await enableDesigner(orgAuth(), ORG_ID);

    expect(getAgentMock).not.toHaveBeenCalled();
    expect(updateAgentMock).toHaveBeenCalledTimes(1);
    expect(updateAgentMock).toHaveBeenCalledWith(expect.anything(), ORG_AGENT_ID, { enabled: true, mode: 'act' });
  });

  it('rejects with partner_admin_required when the partner row needs fixing but the caller cannot read it', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(resolved({ mode: 'off', provenance: { mode: 'partner' } }));
    getAgentMock.mockResolvedValue(null);
    await expect(enableDesigner(orgAuth(), ORG_ID)).rejects.toMatchObject({ code: 'partner_admin_required' });
    expect(updateAgentMock).not.toHaveBeenCalled();
  });

  it('translates agentService refusals into DesignerEnableError codes with their detail', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    createAgentMock.mockRejectedValueOnce(new ActPrerequisitesNotMetError(['recipient']));
    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).rejects.toMatchObject({
      code: 'act_prerequisites_not_met',
      detail: { missing: ['recipient'] },
    });

    createAgentMock.mockRejectedValueOnce(new AgentKindConflictError('designer'));
    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).rejects.toMatchObject({ code: 'agent_kind_exists' });

    createAgentMock.mockRejectedValueOnce(new InvalidAgentRecipientsError(['bad-user'], []));
    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).rejects.toMatchObject({
      code: 'invalid_recipients',
      detail: { invalidUserIds: ['bad-user'], invalidRoleIds: [] },
    });

    resolveEffectiveAgentMock.mockResolvedValue(resolved({ mode: 'off', provenance: { mode: 'partner' } }));
    getAgentMock.mockResolvedValue(agentRow());
    updateAgentMock.mockRejectedValueOnce(new AgentAccessDeniedError());
    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).rejects.toMatchObject({ code: 'partner_admin_required' });
  });

  it('lets unrelated errors propagate untouched', async () => {
    resolveEffectiveAgentMock.mockResolvedValue(null);
    const boom = new Error('boom');
    createAgentMock.mockRejectedValueOnce(boom);
    await expect(enableDesigner(partnerAdminAuth(), ORG_ID)).rejects.toBe(boom);
  });
});
