import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ensurePartnerCutover: vi.fn(async (_partnerId: string) => true),
  readOrgPartnerId: vi.fn(async (_orgId: string): Promise<string | null> => 'p1'),
  findOfferingIdByModel: vi.fn(),
  bindAgentOffering: vi.fn(),
}));
vi.mock('../aiModels/registryCutover', () => ({ ensurePartnerCutover: m.ensurePartnerCutover }));
vi.mock('../aiModels/candidateLoader', () => ({ readOrgPartnerId: m.readOrgPartnerId, findOfferingIdByModel: m.findOfferingIdByModel }));
// The permitted-set, ownership and eligibility rules (incl. the WRITER's
// required_permission) have their own suite: agentOfferingBinding.test.ts.
vi.mock('./agentOfferingBinding', () => ({ bindAgentOffering: m.bindAgentOffering }));

import { AgentModelNotAllowedError, bindAgentModel } from './agentModelBinding';

const writer = { userId: 'u1' };

beforeEach(() => {
  vi.clearAllMocks();
  m.bindAgentOffering.mockImplementation(async (_owner: unknown, offeringId: string | null) => (
    { model: `logical-${offeringId}`, offeringId, offeringPartnerId: 'p1' }));
});

describe('bindAgentModel (W03 string path → W05 offering binding)', () => {
  it('maps the model to its offering on the ai_agents default connection, then binds that offering FOR THE WRITER', async () => {
    m.findOfferingIdByModel.mockResolvedValue('off-2');
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5', writer))
      .resolves.toEqual({ model: 'claude-opus-5-5', offeringId: 'off-2', offeringPartnerId: 'p1' });
    expect(m.ensurePartnerCutover).toHaveBeenCalledWith('p1');
    expect(m.findOfferingIdByModel).toHaveBeenCalledWith({ partnerId: 'p1', orgId: 'o1', surface: 'ai_agents', modelId: 'claude-opus-5-5' });
    expect(m.bindAgentOffering).toHaveBeenCalledWith({ orgId: 'o1', partnerId: null }, 'off-2', writer);
  });

  it('a partner-wide agent looks the model up on the PARTNER assignment (orgId null)', async () => {
    m.findOfferingIdByModel.mockResolvedValue('off-1');
    await bindAgentModel({ orgId: null, partnerId: 'p1' }, 'claude-sonnet-5-5', writer);
    expect(m.readOrgPartnerId).not.toHaveBeenCalled();
    expect(m.findOfferingIdByModel).toHaveBeenCalledWith({ partnerId: 'p1', orgId: null, surface: 'ai_agents', modelId: 'claude-sonnet-5-5' });
    expect(m.bindAgentOffering).toHaveBeenCalledWith({ orgId: null, partnerId: 'p1' }, 'off-1', writer);
  });

  it('the offering binding\'s refusals pass through unchanged (e.g. 403 permission_required for the writer)', async () => {
    m.findOfferingIdByModel.mockResolvedValue('off-2');
    m.bindAgentOffering.mockRejectedValueOnce(new AgentModelNotAllowedError('Your role does not allow this AI model.', 'permission_required'));
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5', writer))
      .rejects.toMatchObject({ status: 403, code: 'permission_required' });
  });

  it('an unknown model is 400 invalid_model and never reaches the offering binding', async () => {
    m.findOfferingIdByModel.mockResolvedValue(null);
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'gpt-free-form', writer)).rejects.toMatchObject({ status: 400, code: 'invalid_model' });
    expect(m.bindAgentOffering).not.toHaveBeenCalled();
  });

  it('an org with no partner is invalid_model, never a registry guess', async () => {
    m.readOrgPartnerId.mockResolvedValueOnce(null);
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5', writer)).rejects.toMatchObject({ status: 400, code: 'invalid_model' });
    expect(m.ensurePartnerCutover).not.toHaveBeenCalled();
  });

  it('null clears the binding without touching the registry', async () => {
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, null, writer)).resolves.toEqual({ model: null, offeringId: null, offeringPartnerId: null });
    expect(m.ensurePartnerCutover).not.toHaveBeenCalled();
    expect(m.bindAgentOffering).not.toHaveBeenCalled();
  });

  it('a partner whose cutover failed is 503, never a guess on a stale registry', async () => {
    m.ensurePartnerCutover.mockResolvedValueOnce(false);
    const err = await bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5', writer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentModelNotAllowedError);
    expect(err).toMatchObject({ status: 503, code: 'registry_unavailable' });
    expect(m.findOfferingIdByModel).not.toHaveBeenCalled();
  });
});

describe('AgentModelNotAllowedError status mapping (W05)', () => {
  it.each([
    ['invalid_model', 400], ['not_permitted', 400], ['model_unavailable', 400],
    ['permission_required', 403], ['registry_unavailable', 503],
  ] as const)('%s → %i', (code, status) => {
    expect(new AgentModelNotAllowedError('x', code).status).toBe(status);
  });
});
