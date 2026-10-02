import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getEffectiveAssignment: vi.fn(),
  readOrgPartnerId: vi.fn(async (_orgId: string): Promise<string | null> => 'p1'),
  ensurePartnerCutover: vi.fn(async (_partnerId: string) => true),
  loadOfferingCandidate: vi.fn(),
  eligibilityContextFor: vi.fn(async (_input: unknown) => ({ ctx: true, userInitiated: false, userHoldsPermission: (_k: string) => false })),
  checkEligibility: vi.fn((_facts: unknown, _ctx: unknown): string | null => null),
  systemDepth: 0,
  depthAtAssignment: -1,
}));
vi.mock('../aiModels/assignments', () => ({
  getEffectiveAssignment: m.getEffectiveAssignment,
  isPermitted: (set: { kind: 'all' } | { kind: 'list'; offeringIds: string[] }, id: string) =>
    set.kind === 'all' || set.offeringIds.includes(id),
}));
vi.mock('../aiModels/candidateLoader', () => ({ readOrgPartnerId: m.readOrgPartnerId, loadOfferingCandidate: m.loadOfferingCandidate }));
vi.mock('../aiModels/registryCutover', () => ({ ensurePartnerCutover: m.ensurePartnerCutover }));
vi.mock('../aiModels/resolveModel', () => ({ eligibilityContextFor: m.eligibilityContextFor, unavailableMessage: (r: string) => r }));
vi.mock('../aiModels/eligibility', () => ({ checkEligibility: m.checkEligibility }));
vi.mock('../aiModels/transport', () => ({ defaultTransport: () => 'agent_sdk' }));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    m.systemDepth += 1;
    try { return await fn(); } finally { m.systemDepth -= 1; }
  },
}));

import { bindAgentOffering } from './agentOfferingBinding';
import { AgentModelNotAllowedError } from './agentModelErrors';

beforeEach(() => {
  vi.clearAllMocks();
  m.getEffectiveAssignment.mockImplementation(async () => {
    m.depthAtAssignment = m.systemDepth;
    return { permitted: { kind: 'list', offeringIds: ['sonnet', 'opus'] }, defaultOfferingId: 'sonnet' };
  });
  m.loadOfferingCandidate.mockImplementation(async (id: string) => ({ offeringId: id, logicalModel: `logical-${id}`, facts: { id } }));
  m.checkEligibility.mockReturnValue(null);
});

const orgOwner = { orgId: 'o1', partnerId: null };
const writer = { userId: 'u1' };

describe('bindAgentOffering (W05)', () => {
  it('null clears the policy model (the agent follows the ai_agents default)', async () => {
    await expect(bindAgentOffering(orgOwner, null, writer)).resolves.toEqual({ model: null, offeringId: null, offeringPartnerId: null });
    expect(m.loadOfferingCandidate).not.toHaveBeenCalled();
    expect(m.ensurePartnerCutover).not.toHaveBeenCalled();
  });

  it('binds a permitted, eligible offering judged for the WRITER on the ai_agents surface', async () => {
    await expect(bindAgentOffering(orgOwner, 'opus', writer)).resolves.toEqual({ model: 'logical-opus', offeringId: 'opus', offeringPartnerId: 'p1' });
    expect(m.eligibilityContextFor).toHaveBeenCalledWith(expect.objectContaining({
      partnerId: 'p1', orgId: 'o1', userId: 'u1', surface: 'ai_agents', transport: 'agent_sdk',
    }));
    expect(m.loadOfferingCandidate).toHaveBeenCalledWith('opus', 'p1');
  });

  it('judges required_permission at the WRITE even though a run skips it (userInitiated forced on)', async () => {
    await bindAgentOffering(orgOwner, 'opus', writer);
    expect(m.checkEligibility).toHaveBeenCalledWith({ id: 'opus' }, expect.objectContaining({ userInitiated: true }));
  });

  it('a write with no human writer fails CLOSED on a permission-gated offering (nobody holds it)', async () => {
    // What the real eligibilityContextFor returns for an empty user id.
    m.eligibilityContextFor.mockResolvedValueOnce({ ctx: true, userInitiated: false, userHoldsPermission: () => false });
    m.checkEligibility.mockImplementationOnce((_f: unknown, ctx: unknown) => {
      const c = ctx as { userInitiated: boolean; userHoldsPermission: (k: string) => boolean };
      return c.userInitiated && !c.userHoldsPermission('ai:premium') ? 'permission_required' : null;
    });
    await expect(bindAgentOffering(orgOwner, 'opus', { userId: '' })).rejects.toMatchObject({ status: 403, code: 'permission_required' });
  });

  it('reads the assignment in a system context (an org-scoped request cannot see the partner rows)', async () => {
    await bindAgentOffering(orgOwner, 'opus', writer);
    expect(m.depthAtAssignment).toBe(1);
    expect(m.getEffectiveAssignment).toHaveBeenCalledWith({ partnerId: 'p1', orgId: 'o1', surface: 'ai_agents', role: 'default' });
  });

  it('the assignment default is always bindable (resolveModel skips the permitted check for it)', async () => {
    m.getEffectiveAssignment.mockResolvedValueOnce({ permitted: { kind: 'list', offeringIds: [] }, defaultOfferingId: 'sonnet' });
    await expect(bindAgentOffering(orgOwner, 'sonnet', writer)).resolves.toMatchObject({ offeringId: 'sonnet' });
  });

  it('an offering outside the ai_agents permitted set → 400 not_permitted, never loaded', async () => {
    await expect(bindAgentOffering(orgOwner, 'haiku', writer)).rejects.toMatchObject({ status: 400, code: 'not_permitted' });
    expect(m.loadOfferingCandidate).not.toHaveBeenCalled();
  });

  it('a premium offering the WRITER lacks the permission for → 403 permission_required, never a fallback (Codex review finding 18)', async () => {
    m.checkEligibility.mockReturnValueOnce('permission_required');
    const err = await bindAgentOffering(orgOwner, 'opus', writer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentModelNotAllowedError);
    expect(err).toMatchObject({ status: 403, code: 'permission_required' });
    // Strict: the default is never tried in its place.
    expect(m.loadOfferingCandidate).toHaveBeenCalledTimes(1);
  });

  it('any other ineligibility → 400 model_unavailable; a foreign/missing offering → 400 not_permitted', async () => {
    m.checkEligibility.mockReturnValueOnce('plan_required');
    await expect(bindAgentOffering(orgOwner, 'opus', writer)).rejects.toMatchObject({ status: 400, code: 'model_unavailable' });
    m.loadOfferingCandidate.mockResolvedValueOnce(null);
    await expect(bindAgentOffering(orgOwner, 'opus', writer)).rejects.toMatchObject({ status: 400, code: 'not_permitted' });
  });

  it("another partner's offering (permitted set 'all') → 400 not_permitted, the same answer as a missing one", async () => {
    m.getEffectiveAssignment.mockResolvedValueOnce({ permitted: { kind: 'all' }, defaultOfferingId: 'sonnet' });
    m.loadOfferingCandidate.mockResolvedValueOnce(null);   // loader returns null for another partner's offering
    const foreign = await bindAgentOffering(orgOwner, 'other-partners-offering', writer).catch((e: unknown) => e);
    m.getEffectiveAssignment.mockResolvedValueOnce({ permitted: { kind: 'all' }, defaultOfferingId: 'sonnet' });
    m.loadOfferingCandidate.mockResolvedValueOnce(null);
    const missing = await bindAgentOffering(orgOwner, 'no-such-offering', writer).catch((e: unknown) => e);
    expect(foreign).toMatchObject({ status: 400, code: 'not_permitted' });
    expect((foreign as Error).message).toBe((missing as Error).message);
    // The ownership rule (checkEligibility's first) also refuses as not_permitted.
    m.checkEligibility.mockReturnValueOnce('not_permitted');
    await expect(bindAgentOffering(orgOwner, 'opus', writer)).rejects.toMatchObject({ status: 400, code: 'not_permitted' });
  });

  it('a partner-wide agent resolves against the partner (no org)', async () => {
    await bindAgentOffering({ orgId: null, partnerId: 'p9' }, 'opus', writer);
    expect(m.getEffectiveAssignment).toHaveBeenCalledWith({ partnerId: 'p9', orgId: null, surface: 'ai_agents', role: 'default' });
    expect(m.eligibilityContextFor).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'p9', orgId: null }));
    expect(m.readOrgPartnerId).not.toHaveBeenCalled();
  });

  it('an org with no partner → 400 not_permitted, never a registry guess', async () => {
    m.readOrgPartnerId.mockResolvedValueOnce(null);
    await expect(bindAgentOffering(orgOwner, 'opus', writer)).rejects.toMatchObject({ status: 400, code: 'not_permitted' });
    expect(m.ensurePartnerCutover).not.toHaveBeenCalled();
  });

  it('a partner not yet cut over → 503 registry_unavailable', async () => {
    m.ensurePartnerCutover.mockResolvedValueOnce(false);
    await expect(bindAgentOffering(orgOwner, 'opus', writer)).rejects.toMatchObject({ status: 503, code: 'registry_unavailable' });
    expect(m.getEffectiveAssignment).not.toHaveBeenCalled();
  });
});
