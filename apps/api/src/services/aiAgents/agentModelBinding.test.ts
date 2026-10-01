import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  ensurePartnerCutover: vi.fn(async () => true),
  readOrgPartnerId: vi.fn(async () => 'p1'),
  findOfferingIdByModel: vi.fn(),
  getEffectiveAssignment: vi.fn(),
  systemDepth: 0,
  depthAtAssignment: -1,
}));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    m.systemDepth += 1;
    try { return await fn(); } finally { m.systemDepth -= 1; }
  },
}));
vi.mock('../aiModels/registryCutover', () => ({ ensurePartnerCutover: m.ensurePartnerCutover }));
vi.mock('../aiModels/candidateLoader', () => ({ readOrgPartnerId: m.readOrgPartnerId, findOfferingIdByModel: m.findOfferingIdByModel }));
vi.mock('../aiModels/assignments', async (orig) => ({
  ...(await orig<typeof import('../aiModels/assignments')>()), getEffectiveAssignment: m.getEffectiveAssignment,
}));

import { AgentModelNotAllowedError, bindAgentModel } from './agentModelBinding';

beforeEach(() => {
  vi.clearAllMocks();
  m.getEffectiveAssignment.mockImplementation(async () => {
    m.depthAtAssignment = m.systemDepth;
    return { defaultOfferingId: 'off-1', permitted: { kind: 'list', offeringIds: ['off-1', 'off-2'] } };
  });
});

describe('bindAgentModel', () => {
  it('maps a permitted model to its offering on the ai_agents default connection (org agent: merged assignment)', async () => {
    m.findOfferingIdByModel.mockResolvedValue('off-2');
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5'))
      .resolves.toEqual({ model: 'claude-opus-5-5', offeringId: 'off-2', offeringPartnerId: 'p1' });
    expect(m.ensurePartnerCutover).toHaveBeenCalledWith('p1');
    expect(m.findOfferingIdByModel).toHaveBeenCalledWith({ partnerId: 'p1', orgId: 'o1', surface: 'ai_agents', modelId: 'claude-opus-5-5' });
    expect(m.getEffectiveAssignment).toHaveBeenCalledWith({ partnerId: 'p1', orgId: 'o1', surface: 'ai_agents' });
  });

  it('reads the assignment in a system context (an org-scoped request cannot see the partner rows)', async () => {
    m.findOfferingIdByModel.mockResolvedValue('off-2');
    await bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5');
    expect(m.depthAtAssignment).toBe(1);
  });

  it('a partner-wide agent checks the PARTNER assignment (orgId null)', async () => {
    m.findOfferingIdByModel.mockResolvedValue('off-1');
    await bindAgentModel({ orgId: null, partnerId: 'p1' }, 'claude-sonnet-5-5');
    expect(m.readOrgPartnerId).not.toHaveBeenCalled();
    expect(m.getEffectiveAssignment).toHaveBeenCalledWith({ partnerId: 'p1', orgId: null, surface: 'ai_agents' });
  });

  it('an unknown model is 400 invalid_model; a model outside the permitted set is 400 not_permitted', async () => {
    m.findOfferingIdByModel.mockResolvedValue(null);
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'gpt-free-form')).rejects.toMatchObject({ status: 400, code: 'invalid_model' });
    m.findOfferingIdByModel.mockResolvedValue('off-9');
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-haiku-4-5')).rejects.toMatchObject({ status: 400, code: 'not_permitted' });
  });

  it('an org with no partner is invalid_model, never a registry guess', async () => {
    m.readOrgPartnerId.mockResolvedValueOnce(null as unknown as string);
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5')).rejects.toMatchObject({ status: 400, code: 'invalid_model' });
    expect(m.ensurePartnerCutover).not.toHaveBeenCalled();
  });

  it('null clears the binding without touching the registry', async () => {
    await expect(bindAgentModel({ orgId: 'o1', partnerId: null }, null)).resolves.toEqual({ model: null, offeringId: null, offeringPartnerId: null });
    expect(m.ensurePartnerCutover).not.toHaveBeenCalled();
  });

  it('a partner whose cutover failed is 503, never a guess on a stale registry', async () => {
    m.ensurePartnerCutover.mockResolvedValueOnce(false);
    const err = await bindAgentModel({ orgId: 'o1', partnerId: null }, 'claude-opus-5-5').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentModelNotAllowedError);
    expect(err).toMatchObject({ status: 503, code: 'registry_unavailable' });
    expect(m.findOfferingIdByModel).not.toHaveBeenCalled();
  });
});
