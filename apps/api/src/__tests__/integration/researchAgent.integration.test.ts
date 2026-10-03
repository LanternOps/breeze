import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { updateAgent } from '../../services/aiAgents/agentService';
import {
  ensureResearchAgent, ResearchAgentEditError, ResearchBaselineConflictError,
} from '../../services/aiAgents/researchProvisioning';
import { createOrganization, createPartner, createUser } from './db-utils';

const baselineRows = (partnerId: string) => withSystemDbAccessContext(() => db.select().from(aiAgents)
  .where(and(eq(aiAgents.partnerId, partnerId), eq(aiAgents.kind, 'research'), isNull(aiAgents.disabledAt))));

describe('research agent provisioning (real Postgres)', () => {
  it('ten concurrent first-admissions create exactly one partner baseline', async () => {
    const partner = await createPartner();
    const results = await Promise.all(Array.from({ length: 10 }, () => ensureResearchAgent(partner.id)));
    expect(new Set(results.map((r) => r.agentId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await baselineRows(partner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ createdBy: null, provisionedBy: 'system:remediation_research', mode: 'act', enabled: true });
  });

  it('a later call is a no-op that returns the same row', async () => {
    const partner = await createPartner();
    const first = await ensureResearchAgent(partner.id);
    await expect(ensureResearchAgent(partner.id)).resolves.toEqual({ agentId: first.agentId, created: false });
  });

  it('fails closed on a pre-existing user-created partner research row and does not touch it', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const [squat] = await withSystemDbAccessContext(() => db.insert(aiAgents).values({
      partnerId: partner.id, orgId: null, kind: 'research', name: 'squatter', createdBy: user.id,
    }).returning());
    await expect(ensureResearchAgent(partner.id)).rejects.toBeInstanceOf(ResearchBaselineConflictError);
    const rows = await baselineRows(partner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: squat!.id, createdBy: user.id, provisionedBy: null, name: 'squatter' });
  });

  it('the provisioned agent can be disabled, re-enabled and capped through the real agentService', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const { agentId } = await ensureResearchAgent(partner.id);
    const auth = {
      principal: { kind: 'user_session' }, user: { id: user.id, email: user.email, name: 'Tech', isPlatformAdmin: false },
      partnerId: partner.id, orgId: null, scope: 'partner', accessibleOrgIds: [org.id], partnerOrgAccess: 'all',
      canAccessOrg: (id: string) => id === org.id, orgCondition: () => undefined,
    } as unknown as AuthContext;
    const ctx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id], userId: user.id, currentPartnerId: partner.id,
    };
    await withDbAccessContext(ctx, () => updateAgent(auth, agentId, { enabled: false } as never));
    await withDbAccessContext(ctx, () => updateAgent(auth, agentId, { enabled: true, limits: { researchDeepBudgetCentsPerRun: 40 } } as never));
    await expect(withDbAccessContext(ctx, () => updateAgent(auth, agentId, { mode: 'off' } as never)))
      .rejects.toBeInstanceOf(ResearchAgentEditError);
    const [row] = await withSystemDbAccessContext(() => db.select().from(aiAgents).where(eq(aiAgents.id, agentId)));
    expect(row).toMatchObject({ enabled: true, mode: 'act', createdBy: null, provisionedBy: 'system:remediation_research' });
    expect((row!.limits as Record<string, number>).researchDeepBudgetCentsPerRun).toBe(40);
  });
});
