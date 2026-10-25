/**
 * Wisp W08 (#9914, feature #9906; PR #10066 review) — entity loaders against
 * real Postgres. Proves, per kind, that `loadEntityForPartner` is pinned to the
 * partner; that hidden-type and soft-deleted orgs (and soft-deleted tickets)
 * read as missing; that site fields come back from the row; and that a
 * site-restricted grant ceiling refuses a same-org device in another site.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { WISP_ENTITY_KINDS, type WispEntityKind } from '@breeze/shared';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  aiAgentRuns,
  aiAgents,
  aiOperatorTasks,
  alerts,
  contracts,
  devices,
  invoices,
  organizations,
  quotes,
  tickets,
  wispGrantRevisions,
  wispGrants,
} from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { loadEntityForPartner } from '../../services/wisp/entityLoaders';
import { resolveEntityRef } from '../../services/wisp/entityRefs';
import { resolveGrantCeiling } from '../../services/wisp/grantAuthority';
import { getOrCreateUnassignedPoolOrg } from '../../services/unassignedPool/poolOrg';
import { getOrCreateThread } from '../../services/wisp/threads';
import {
  assignUserToPartner,
  createDevice,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());

type Seeded = { id: string; siteId?: string | null };

/** One entity of `kind` inside `org` (and `partnerId`). */
async function seedEntity(kind: WispEntityKind, partnerId: string, orgId: string, userId: string): Promise<Seeded> {
  const site = await createSite({ orgId });
  const sfx = randomUUID().slice(0, 12);
  switch (kind) {
    case 'ticket':
      return asSystem(async () => {
        const [t] = await db.insert(tickets).values({
          orgId, partnerId, ticketNumber: `EL-${sfx}`, subject: 'loader ticket', source: 'manual',
        }).returning({ id: tickets.id });
        return { id: t!.id };
      });
    case 'quote':
      return asSystem(async () => {
        const [q] = await db.insert(quotes).values({
          partnerId, orgId, siteId: site!.id, currencyCode: 'USD', status: 'sent', quoteNumber: `Q-${sfx}`,
        }).returning({ id: quotes.id });
        return { id: q!.id, siteId: site!.id };
      });
    case 'invoice':
      return asSystem(async () => {
        const [i] = await db.insert(invoices).values({
          partnerId, orgId, siteId: site!.id, status: 'sent', currencyCode: 'USD', invoiceNumber: `INV-${sfx}`,
          subtotal: '10.00', total: '10.00', balance: '10.00', issueDate: '2026-10-01', dueDate: '2026-10-31',
        }).returning({ id: invoices.id });
        return { id: i!.id, siteId: site!.id };
      });
    case 'contract':
      return asSystem(async () => {
        const [c] = await db.insert(contracts).values({
          partnerId, orgId, name: `Contract ${sfx}`, intervalMonths: 1, startDate: '2026-10-01', currencyCode: 'USD',
        }).returning({ id: contracts.id });
        return { id: c!.id };
      });
    case 'device': {
      const d = await createDevice({ orgId, siteId: site!.id });
      return { id: d.id, siteId: site!.id };
    }
    case 'organization':
      return { id: orgId };
    case 'site':
      return { id: site!.id, siteId: site!.id };
    case 'alert': {
      const d = await createDevice({ orgId, siteId: site!.id });
      return asSystem(async () => {
        const [a] = await db.insert(alerts).values({
          orgId, deviceId: d.id, severity: 'high', title: `Alert ${sfx}`,
        }).returning({ id: alerts.id });
        return { id: a!.id };
      });
    }
    case 'run':
    case 'task': {
      return asSystem(async () => {
        const [agent] = await db.insert(aiAgents).values({
          kind: 'triage', name: `Agent ${sfx}`, orgId, partnerId: null, createdBy: userId,
        }).returning({ id: aiAgents.id });
        if (kind === 'run') {
          const [r] = await db.insert(aiAgentRuns).values({
            agentId: agent!.id, orgId, deviceId: null, profile: 'narrative', triggerKind: 'schedule',
            triggerRef: {}, dedupeKey: `loader:${sfx}`, modeAtStart: 'shadow', policySnapshot: {} as never, status: 'running',
          }).returning({ id: aiAgentRuns.id });
          return { id: r!.id };
        }
        const [t] = await db.insert(aiOperatorTasks).values({
          orgId, agentId: agent!.id, agentKind: 'triage', agentName: 'Operator',
          workflowKey: 'service_recovery', workflowVersion: 1, originKind: 'manual' as const,
          requesterUserId: userId, objective: 'loader task', deviceId: null, state: 'running',
          revision: 1, leaseEpoch: 0, deadlineAt: new Date(Date.now() + 3_600_000),
        }).returning({ id: aiOperatorTasks.id });
        return { id: t!.id };
      });
    }
    case 'user':
      return { id: userId };
  }
}

const seedTicketOnly = (partnerId: string, orgId: string) => asSystem(async () => {
  const [t] = await db.insert(tickets).values({
    orgId, partnerId, ticketNumber: `EL-${randomUUID().slice(0, 12)}`, subject: 'hidden-org ticket', source: 'manual',
  }).returning({ id: tickets.id });
  return t!;
});

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, email: `wisp-el-${randomUUID()}@wisp.test` });
  return { partner, org, user };
}

describe('loadEntityForPartner: partner pin for every kind', () => {
  it('covers every WISP_ENTITY_KIND', () => {
    expect([...WISP_ENTITY_KINDS].sort()).toEqual(
      ['alert', 'contract', 'device', 'invoice', 'organization', 'quote', 'run', 'site', 'task', 'ticket', 'user'],
    );
  });

  it.each([...WISP_ENTITY_KINDS])('%s in partner B is null for partner A, found for partner B', async (kind) => {
    const a = await tenant();
    const b = await tenant();
    const seeded = await seedEntity(kind, b.partner.id, b.org.id, b.user.id);

    expect(await loadEntityForPartner(kind, seeded.id, a.partner.id)).toBeNull();
    const found = await loadEntityForPartner(kind, seeded.id, b.partner.id);
    expect(found).not.toBeNull();
    expect(found!.orgId).toBe(kind === 'user' ? null : b.org.id);
  });
});

describe('loadEntityForPartner: hidden and deleted orgs', () => {
  it.each(['quick_support', 'unassigned_pool'] as const)('ticket and device in a %s org are null', async (type) => {
    const t = await tenant();
    let orgId: string;
    let device: { id: string };
    if (type === 'quick_support') {
      orgId = (await createOrganization({ partnerId: t.partner.id, type })).id;
      device = await createDevice({ orgId, siteId: (await createSite({ orgId }))!.id });
    } else {
      // The holding org is minted only by the pool helper, and a device lands in
      // it only through enrollment admission (DB triggers enforce both).
      const pool = await getOrCreateUnassignedPoolOrg(t.partner.id);
      orgId = pool.orgId;
      device = await asSystem(async () => {
        await db.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', true)`);
        const [d] = await db.insert(devices).values({
          orgId, siteId: pool.siteId, agentId: `agent-${randomUUID()}`, hostname: `host-${randomUUID().slice(0, 8)}`,
          osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '2.0.0',
        }).returning({ id: devices.id });
        return d!;
      });
    }
    const ticket = await seedTicketOnly(t.partner.id, orgId);
    expect(await loadEntityForPartner('ticket', ticket.id, t.partner.id)).toBeNull();
    expect(await loadEntityForPartner('device', device.id, t.partner.id)).toBeNull();
    // control: same shapes in the live customer org resolve
    const okTicket = await seedEntity('ticket', t.partner.id, t.org.id, t.user.id);
    const okDevice = await seedEntity('device', t.partner.id, t.org.id, t.user.id);
    expect(await loadEntityForPartner('ticket', okTicket.id, t.partner.id)).not.toBeNull();
    expect(await loadEntityForPartner('device', okDevice.id, t.partner.id)).not.toBeNull();
  });

  it('a soft-deleted org hides its ticket and itself; control org resolves', async () => {
    const t = await tenant();
    const gone = await createOrganization({ partnerId: t.partner.id });
    const ticket = await seedEntity('ticket', t.partner.id, gone.id, t.user.id);
    expect(await loadEntityForPartner('ticket', ticket.id, t.partner.id)).not.toBeNull();
    expect(await loadEntityForPartner('organization', gone.id, t.partner.id)).not.toBeNull();
    await asSystem(() => db.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, gone.id)));
    expect(await loadEntityForPartner('ticket', ticket.id, t.partner.id)).toBeNull();
    expect(await loadEntityForPartner('organization', gone.id, t.partner.id)).toBeNull();
    expect(await loadEntityForPartner('organization', t.org.id, t.partner.id)).not.toBeNull();
  });

  it('a soft-deleted ticket is null', async () => {
    const t = await tenant();
    const ticket = await seedEntity('ticket', t.partner.id, t.org.id, t.user.id);
    expect(await loadEntityForPartner('ticket', ticket.id, t.partner.id)).not.toBeNull();
    await asSystem(() => db.update(tickets).set({ deletedAt: new Date() }).where(eq(tickets.id, ticket.id)));
    expect(await loadEntityForPartner('ticket', ticket.id, t.partner.id)).toBeNull();
  });
});

describe('loadEntityForPartner: site fields', () => {
  it.each(['device', 'site', 'quote', 'invoice'] as const)('%s returns its site id', async (kind) => {
    const t = await tenant();
    const seeded = await seedEntity(kind, t.partner.id, t.org.id, t.user.id);
    const found = await loadEntityForPartner(kind, seeded.id, t.partner.id);
    expect(seeded.siteId).toBeTruthy();
    expect(found!.siteId).toBe(seeded.siteId);
  });

  it('a quote and an invoice without a site return siteId null (site-bearing, unset)', async () => {
    const t = await tenant();
    const sfx = randomUUID().slice(0, 12);
    const { q, i } = await asSystem(async () => {
      const [q] = await db.insert(quotes).values({
        partnerId: t.partner.id, orgId: t.org.id, currencyCode: 'USD', status: 'sent', quoteNumber: `Q-${sfx}`,
      }).returning({ id: quotes.id });
      const [i] = await db.insert(invoices).values({
        partnerId: t.partner.id, orgId: t.org.id, status: 'sent', currencyCode: 'USD', invoiceNumber: `INV-${sfx}`,
        subtotal: '10.00', total: '10.00', balance: '10.00', issueDate: '2026-10-01', dueDate: '2026-10-31',
      }).returning({ id: invoices.id });
      return { q: q!, i: i! };
    });
    expect((await loadEntityForPartner('quote', q.id, t.partner.id))!.siteId).toBeNull();
    expect((await loadEntityForPartner('invoice', i.id, t.partner.id))!.siteId).toBeNull();
  });
});

describe('resolveEntityRef: site-restricted ceiling end to end', () => {
  it('a device in the allowed site resolves; a device in another site of the same org is outside_ceiling', async () => {
    const t = await tenant();
    const keys = ['ai_sessions:use', 'devices:read'];
    const siteA = await createSite({ orgId: t.org.id });
    const siteB = await createSite({ orgId: t.org.id });
    const devA = await createDevice({ orgId: t.org.id, siteId: siteA!.id });
    const devB = await createDevice({ orgId: t.org.id, siteId: siteB!.id });

    const role = await createRole({ scope: 'partner', partnerId: t.partner.id });
    await grantRolePermissions(role.id, keys.map((k) => {
      const [resource, action] = k.split(':') as [string, string];
      return { resource, action };
    }));
    await assignUserToPartner(t.user.id, t.partner.id, role.id, 'all');

    const grantId = await asSystem(async () => {
      const [g] = await db.insert(wispGrants).values({
        partnerId: t.partner.id, orgId: null, grantorUserId: t.user.id,
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
      }).returning({ id: wispGrants.id });
      return g!.id;
    });
    const snapshot: WispCeilingSnapshot = {
      version: 1, permissionKeys: keys, orgIds: [t.org.id], siteIds: [siteA!.id],
      toolAllowlist: null, deniedTools: [], partnerWide: true,
    };
    const revisionId = await asSystem(async () => {
      const [r] = await db.insert(wispGrantRevisions).values({
        grantId, partnerId: t.partner.id, revision: 1, ceilingSnapshot: snapshot,
        factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
      }).returning({ id: wispGrantRevisions.id });
      await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, grantId));
      return r!.id;
    });
    await getOrCreateThread(grantId);

    const ceiling = await resolveGrantCeiling(grantId, revisionId);
    expect(ceiling.siteIds && [...ceiling.siteIds]).toEqual([siteA!.id]);

    const auth = {
      principal: { kind: 'user' },
      user: { id: t.user.id, email: t.user.email, name: 'Grantor', isPlatformAdmin: false },
      token: null, partnerId: t.partner.id, orgId: null, scope: 'partner', partnerOrgAccess: 'all',
      accessibleOrgIds: [t.org.id],
      ...buildOrgAccessClosures([t.org.id]),
    } as unknown as AuthContext;
    const ctx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [t.org.id], accessiblePartnerIds: [t.partner.id],
      userId: t.user.id, currentPartnerId: t.partner.id,
    };

    const inA = await withDbAccessContext(ctx, () => resolveEntityRef({ auth, ceiling }, { kind: 'device', id: devA.id }));
    expect(inA).toMatchObject({ orgId: t.org.id });
    expect(inA).not.toHaveProperty('reason');
    const inB = await withDbAccessContext(ctx, () => resolveEntityRef({ auth, ceiling }, { kind: 'device', id: devB.id }));
    expect(inB).toEqual({ reason: 'outside_ceiling' });
  });
});
