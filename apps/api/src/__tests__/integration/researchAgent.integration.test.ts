import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents, alerts, devices, scripts } from '../../db/schema';
import { loadResearchContext } from '../../services/aiAgents/researchContext';
import type { AuthContext } from '../../middleware/auth';
import { updateAgent } from '../../services/aiAgents/agentService';
import {
  ensureResearchAgent, ResearchAgentEditError, ResearchBaselineConflictError,
} from '../../services/aiAgents/researchProvisioning';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

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

describe('research refs (real Postgres, system scope like loadRunContext)', () => {
  it('include own partner-wide and own-org scripts for the device OS; exclude other orgs and other OSes', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const site = await createSite({ orgId: orgA.id });
    const [device] = await withSystemDbAccessContext(() => db.insert(devices).values({
      orgId: orgA.id, siteId: site.id, agentId: randomUUID(), hostname: 'WS-REF', osType: 'windows', osVersion: '11',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online', enrolledAt: new Date(),
    }).returning({ id: devices.id }));
    const [alert] = await withSystemDbAccessContext(() => db.insert(alerts).values({
      orgId: orgA.id, deviceId: device!.id, severity: 'high', title: 'Spooler stopped',
    }).returning({ id: alerts.id }));
    const mk = (name: string, v: Partial<typeof scripts.$inferInsert>) =>
      ({ name, language: 'powershell' as const, content: 'x', osTypes: ['windows'], ...v });
    const inserted = await withSystemDbAccessContext(() => db.insert(scripts).values([
      mk('partner-win', { partnerId: partner.id }),
      mk('orgA-win', { orgId: orgA.id, partnerId: partner.id }),
      mk('orgB-win', { orgId: orgB.id, partnerId: partner.id }),
      mk('otherPartner-win', { partnerId: otherPartner.id }),
      mk('partner-linux', { partnerId: partner.id, osTypes: ['linux'], language: 'bash' }),
    ]).returning({ id: scripts.id, name: scripts.name }));
    const id = (n: string) => inserted.find((r) => r.name === n)!.id;

    const ctx = await withSystemDbAccessContext(() => loadResearchContext({
      orgId: orgA.id, partnerId: partner.id, deviceId: device!.id,
      triggerRef: { depth: 'quick', sourceType: 'alert', sourceId: alert!.id },
    }));
    expect(ctx.device.osType).toBe('windows');
    expect(ctx.refs.scriptIds.has(id('partner-win'))).toBe(true);
    expect(ctx.refs.scriptIds.has(id('orgA-win'))).toBe(true);
    expect(ctx.refs.scriptIds.has(id('orgB-win'))).toBe(false);
    expect(ctx.refs.scriptIds.has(id('otherPartner-win'))).toBe(false);
    expect(ctx.refs.scriptIds.has(id('partner-linux'))).toBe(false);
    expect(ctx.refs.scriptIdsAnyOs.has(id('partner-linux'))).toBe(true);
    expect(ctx.refs.scriptIdsAnyOs.has(id('orgB-win'))).toBe(false);
    expect(ctx.catalog.scripts.map((s) => s.id)).toEqual(expect.arrayContaining([id('partner-win'), id('orgA-win')]));
    expect(ctx.catalog.scripts.map((s) => s.id)).not.toContain(id('partner-linux'));
  });
});
