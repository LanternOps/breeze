/**
 * Integration test — manage_tickets WRITE actions honour the site axis and the
 * org axis (W02 #6756, Task 15a), against real Postgres as the unprivileged
 * `breeze_app` role (org-axis RLS genuinely enforced; the site axis is applied
 * app-layer by `findTicketWithAccess`).
 *
 * Fixture: two sites in one org (A = caller's allowed site, B = forbidden),
 * a device in each, a ticket bound to each device, one device-less ticket,
 * plus a second org with its own device-bound ticket.
 *
 * For every write action:
 *   (i)   out-of-site ticket  -> `Ticket not found`, row unchanged
 *   (ii)  in-site ticket      -> succeeds (non-vacuous)
 *   (iii) cross-org ticket    -> `Ticket not found`, row unchanged
 *   (iv)  unrestricted caller -> reaches the out-of-site ticket
 *
 * Plus: `list` as a site-restricted caller returns in-site + device-less
 * tickets only, and the agent-principal triage comment is stored private even
 * when the input asks for `isPublic: true`.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, ticketComments, tickets } from '../../db/schema';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { registerTicketingTools } from '../../services/aiToolsTicketing';
import { buildAgentAuthContext, agentDbAccessContext } from '../../services/aiAgents/agentAuthContext';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

// publishEvent writes to a Redis stream; ticket writes emit events. Same
// stand-in as aiAgentTicketTriage.integration.test.ts.
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

function ticketHandler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerTicketingTools(reg);
  return reg.get('manage_tickets')!.handler;
}

function makeAuth(opts: {
  userId: string;
  partnerId: string;
  orgId: string;
  allowedSiteIds?: string[];
}): AuthContext {
  const { allowedSiteIds } = opts;
  return {
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: opts.partnerId,
    orgId: opts.orgId,
    scope: 'organization',
    accessibleOrgIds: [opts.orgId],
    orgCondition: (col: any) => eq(col, opts.orgId),
    canAccessOrg: (id: string) => id === opts.orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

function orgCtx(f: { orgId: string; partnerId: string; userId: string }): DbAccessContext {
  return {
    scope: 'organization',
    orgId: f.orgId,
    accessibleOrgIds: [f.orgId],
    accessiblePartnerIds: [],
    userId: f.userId,
    currentPartnerId: f.partnerId,
  };
}

async function seedTicket(orgId: string, partnerId: string, deviceId: string | null, subject: string) {
  const [t] = await (getTestDb() as any)
    .insert(tickets)
    .values({
      orgId,
      partnerId,
      ticketNumber: `SC-${randomUUID().slice(0, 8)}`,
      subject,
      source: 'manual',
      priority: 'normal',
      deviceId,
    })
    .returning();
  return t as typeof tickets.$inferSelect;
}

async function seedComment(ticketId: string, userId: string, content: string) {
  const [c] = await (getTestDb() as any)
    .insert(ticketComments)
    .values({ ticketId, userId, authorName: 'Op', authorType: 'internal', commentType: 'internal', content, isPublic: false })
    .returning();
  return c as typeof ticketComments.$inferSelect;
}

async function loadTicket(id: string) {
  const [row] = await (getTestDb() as any).select().from(tickets).where(eq(tickets.id, id));
  return row as typeof tickets.$inferSelect;
}

async function loadComment(id: string) {
  const [row] = await (getTestDb() as any).select().from(ticketComments).where(eq(ticketComments.id, id));
  return row as typeof ticketComments.$inferSelect;
}

async function commentsFor(ticketId: string) {
  return (getTestDb() as any).select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId)) as Promise<Array<typeof ticketComments.$inferSelect>>;
}

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  siteA: string;
  siteB: string;
  ticketIn: typeof tickets.$inferSelect;
  ticketOut: typeof tickets.$inferSelect;
  ticketNoDevice: typeof tickets.$inferSelect;
  ticketOtherOrg: typeof tickets.$inferSelect;
  restricted: AuthContext;
  unrestricted: AuthContext;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `tw-${randomUUID()}@ticket-scope.test` });

  const siteA = await createSite({ orgId: org.id });
  const siteB = await createSite({ orgId: org.id });
  const otherSite = await createSite({ orgId: otherOrg.id });
  const devA = await createDevice({ orgId: org.id, siteId: siteA.id });
  const devB = await createDevice({ orgId: org.id, siteId: siteB.id });
  const devOther = await createDevice({ orgId: otherOrg.id, siteId: otherSite.id });

  const ticketIn = await seedTicket(org.id, partner.id, devA.id, 'in-site ticket');
  const ticketOut = await seedTicket(org.id, partner.id, devB.id, 'out-of-site ticket');
  const ticketNoDevice = await seedTicket(org.id, partner.id, null, 'device-less ticket');
  const ticketOtherOrg = await seedTicket(otherOrg.id, partner.id, devOther.id, 'other-org ticket');

  const base = { userId: user.id, partnerId: partner.id, orgId: org.id };
  return {
    partnerId: partner.id,
    orgId: org.id,
    userId: user.id,
    siteA: siteA.id,
    siteB: siteB.id,
    ticketIn,
    ticketOut,
    ticketNoDevice,
    ticketOtherOrg,
    restricted: makeAuth({ ...base, allowedSiteIds: [siteA.id] }),
    unrestricted: makeAuth(base),
  };
}

const NOT_FOUND = { error: 'Ticket not found' };

async function call(f: Fixture, auth: AuthContext, input: Record<string, unknown>) {
  const raw = await withDbAccessContext(orgCtx(f), async () => ticketHandler()(input, auth));
  return JSON.parse(raw);
}

describe('manage_tickets writes — site axis + org axis (real Postgres, breeze_app)', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seedFixture();
    publishEventMock.mockClear();
  });

  it('comment: out-of-site and cross-org are not found and write nothing; in-site internal and public succeed', async () => {
    for (const isPublic of [false, true]) {
      expect(await call(f, f.restricted, { action: 'comment', ticketId: f.ticketOut.id, content: 'x', isPublic })).toEqual(NOT_FOUND);
      expect(await call(f, f.restricted, { action: 'comment', ticketId: f.ticketOtherOrg.id, content: 'x', isPublic })).toEqual(NOT_FOUND);
    }
    expect(await commentsFor(f.ticketOut.id)).toHaveLength(0);
    expect(await commentsFor(f.ticketOtherOrg.id)).toHaveLength(0);

    const internal = await call(f, f.restricted, { action: 'comment', ticketId: f.ticketIn.id, content: 'internal note', isPublic: false });
    expect(internal.error).toBeUndefined();
    expect((await loadComment(internal.comment.id)).isPublic).toBe(false);

    const pub = await call(f, f.restricted, { action: 'comment', ticketId: f.ticketIn.id, content: 'public reply', isPublic: true });
    expect(pub.error).toBeUndefined();
    expect((await loadComment(pub.comment.id)).isPublic).toBe(true);

    // device-less tickets are org-level, not device-attributable: stay writable
    const orgLevel = await call(f, f.restricted, { action: 'comment', ticketId: f.ticketNoDevice.id, content: 'org-level', isPublic: false });
    expect(orgLevel.error).toBeUndefined();

    // unrestricted caller reaches the out-of-site ticket
    const wide = await call(f, f.unrestricted, { action: 'comment', ticketId: f.ticketOut.id, content: 'wide', isPublic: false });
    expect(wide.error).toBeUndefined();
    expect(await commentsFor(f.ticketOut.id)).toHaveLength(1);
  });

  it('update_status: out-of-site and cross-org are not found with status unchanged; in-site succeeds', async () => {
    const before = f.ticketOut.status;
    expect(await call(f, f.restricted, { action: 'update_status', ticketId: f.ticketOut.id, status: 'on_hold' })).toEqual(NOT_FOUND);
    expect(await call(f, f.restricted, { action: 'update_status', ticketId: f.ticketOtherOrg.id, status: 'on_hold' })).toEqual(NOT_FOUND);
    expect((await loadTicket(f.ticketOut.id)).status).toBe(before);
    expect((await loadTicket(f.ticketOtherOrg.id)).status).toBe(f.ticketOtherOrg.status);

    const ok = await call(f, f.restricted, { action: 'update_status', ticketId: f.ticketIn.id, status: 'on_hold' });
    expect(ok.error).toBeUndefined();
    expect((await loadTicket(f.ticketIn.id)).status).toBe('on_hold');

    const wide = await call(f, f.unrestricted, { action: 'update_status', ticketId: f.ticketOut.id, status: 'on_hold' });
    expect(wide.error).toBeUndefined();
    expect((await loadTicket(f.ticketOut.id)).status).toBe('on_hold');
  });

  it('update_fields: out-of-site and cross-org are not found with fields unchanged; in-site succeeds', async () => {
    const fields = { priority: 'urgent' };
    expect(await call(f, f.restricted, { action: 'update_fields', ticketId: f.ticketOut.id, fields })).toEqual(NOT_FOUND);
    expect(await call(f, f.restricted, { action: 'update_fields', ticketId: f.ticketOtherOrg.id, fields })).toEqual(NOT_FOUND);
    expect((await loadTicket(f.ticketOut.id)).priority).toBe('normal');
    expect((await loadTicket(f.ticketOtherOrg.id)).priority).toBe('normal');

    const ok = await call(f, f.restricted, { action: 'update_fields', ticketId: f.ticketIn.id, fields });
    expect(ok.error).toBeUndefined();
    expect((await loadTicket(f.ticketIn.id)).priority).toBe('urgent');

    const wide = await call(f, f.unrestricted, { action: 'update_fields', ticketId: f.ticketOut.id, fields });
    expect(wide.error).toBeUndefined();
    expect((await loadTicket(f.ticketOut.id)).priority).toBe('urgent');
  });

  it('update_fields: re-pointing an in-site ticket at an out-of-site device is refused and deviceId is unchanged', async () => {
    const devB = f.ticketOut.deviceId!;
    const res = await call(f, f.restricted, { action: 'update_fields', ticketId: f.ticketIn.id, fields: { deviceId: devB } });
    expect(res).toEqual({ error: 'Device not found or access denied' });
    expect((await loadTicket(f.ticketIn.id)).deviceId).toBe(f.ticketIn.deviceId);
  });

  it('edit_comment / delete_comment: out-of-site and cross-org tickets are not found even for the comment author; in-site succeeds', async () => {
    // Authored by the acting user on purpose: the service-level "own comment"
    // rule would let the edit through, so only the site gate can refuse it.
    const outComment = await seedComment(f.ticketOut.id, f.userId, 'original-out');
    const otherOrgComment = await seedComment(f.ticketOtherOrg.id, f.userId, 'original-other-org');
    const inComment = await seedComment(f.ticketIn.id, f.userId, 'original-in');

    for (const c of [outComment, otherOrgComment]) {
      const ticketId = c.ticketId;
      expect(await call(f, f.restricted, { action: 'edit_comment', commentId: c.id, expectedTicketId: ticketId, content: 'hacked' })).toEqual(NOT_FOUND);
      expect(await call(f, f.restricted, { action: 'delete_comment', commentId: c.id, expectedTicketId: ticketId })).toEqual(NOT_FOUND);
      const row = await loadComment(c.id);
      expect(row.content).toMatch(/^original-/);
      expect(row.deletedAt).toBeNull();
      expect(row.editedAt).toBeNull();
    }

    const edited = await call(f, f.restricted, { action: 'edit_comment', commentId: inComment.id, expectedTicketId: f.ticketIn.id, content: 'edited' });
    expect(edited.error).toBeUndefined();
    expect((await loadComment(inComment.id)).content).toBe('edited');

    const deleted = await call(f, f.restricted, { action: 'delete_comment', commentId: inComment.id, expectedTicketId: f.ticketIn.id });
    expect(deleted.error).toBeUndefined();
    expect((await loadComment(inComment.id)).deletedAt).not.toBeNull();

    const wide = await call(f, f.unrestricted, { action: 'edit_comment', commentId: outComment.id, expectedTicketId: f.ticketOut.id, content: 'wide edit' });
    expect(wide.error).toBeUndefined();
    expect((await loadComment(outComment.id)).content).toBe('wide edit');
  });

  it('link_alert: the ticket site/org gate fires before the alert lookup', async () => {
    const alertId = randomUUID();
    expect(await call(f, f.restricted, { action: 'link_alert', ticketId: f.ticketOut.id, alertId })).toEqual(NOT_FOUND);
    expect(await call(f, f.restricted, { action: 'link_alert', ticketId: f.ticketOtherOrg.id, alertId })).toEqual(NOT_FOUND);
    // Discriminator: an in-site ticket passes the ticket gate and fails LATER,
    // on the alert, so "Ticket not found" above is the site/org guard talking.
    expect(await call(f, f.restricted, { action: 'link_alert', ticketId: f.ticketIn.id, alertId })).toEqual({ error: 'Alert not found' });
    expect(await call(f, f.unrestricted, { action: 'link_alert', ticketId: f.ticketOut.id, alertId })).toEqual({ error: 'Alert not found' });
  });

  it('list: a site-restricted caller sees in-site + device-less tickets only; unrestricted sees all org tickets; never another org', async () => {
    const restricted = await call(f, f.restricted, { action: 'list', limit: 100 });
    const ids = (restricted.tickets as Array<{ id: string }>).map((t) => t.id).sort();
    expect(ids).toEqual([f.ticketIn.id, f.ticketNoDevice.id].sort());

    const wide = await call(f, f.unrestricted, { action: 'list', limit: 100 });
    const wideIds = (wide.tickets as Array<{ id: string }>).map((t) => t.id).sort();
    expect(wideIds).toEqual([f.ticketIn.id, f.ticketOut.id, f.ticketNoDevice.id].sort());
    expect(wideIds).not.toContain(f.ticketOtherOrg.id);
  });

  it('agent-principal triage comment is stored private (isPublic=false, ai_agent origin) even with isPublic:true input', async () => {
    const adminDb = getTestDb() as any;
    const [agent] = await adminDb.insert(aiAgents).values({
      partnerId: f.partnerId,
      orgId: null,
      kind: 'helpdesk',
      name: 'Helpdesk Agent',
      enabled: true,
      mode: 'shadow',
      toolAllowlist: ['manage_tickets'],
      protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      limits: {},
      triggers: {},
      recipients: { userIds: [], roleIds: [] },
      createdBy: f.userId,
    }).returning();
    const [run] = await adminDb.insert(aiAgentRuns).values({
      agentId: agent.id,
      orgId: f.orgId,
      deviceId: null,
      ticketId: f.ticketNoDevice.id,
      triggerKind: 'ticket',
      dedupeKey: `ticket-scope-${randomUUID()}`,
      modeAtStart: 'shadow',
      policySnapshot: { effective: { enabled: true, mode: 'shadow', toolAllowlist: ['manage_tickets'] } } as never,
      profile: 'triage',
    }).returning();

    const agentAuth = buildAgentAuthContext(
      { id: agent.id, orgId: null, partnerId: f.partnerId, name: 'Helpdesk Agent', kind: 'helpdesk' },
      { id: run.id, orgId: f.orgId, deviceId: null },
      { id: f.orgId, partnerId: f.partnerId },
    );
    const raw = await withDbAccessContext(agentDbAccessContext(f.orgId, f.partnerId), async () =>
      ticketHandler()({ action: 'comment', ticketId: f.ticketNoDevice.id, content: 'AI triage summary', isPublic: true }, agentAuth),
    );
    const res = JSON.parse(raw);
    expect(res.error).toBeUndefined();

    const row = await loadComment(res.comment.id);
    expect(row.isPublic).toBe(false);
    expect(row.commentType).toBe('internal');
    expect(row.originPrincipalKind).toBe('ai_agent');
    expect(row.originPrincipalId).toBe(agent.id);
    expect(row.agentRunId).toBe(run.id);

    // The other agent-principal refusal that protects customer-visible state.
    const refused = JSON.parse(await withDbAccessContext(agentDbAccessContext(f.orgId, f.partnerId), async () =>
      ticketHandler()({ action: 'update_status', ticketId: f.ticketNoDevice.id, status: 'resolved' }, agentAuth),
    ));
    expect(refused).toEqual({ error: 'agent_principal_unsupported_action', action: 'update_status' });
    expect((await loadTicket(f.ticketNoDevice.id)).status).toBe(f.ticketNoDevice.status);
  });
});
