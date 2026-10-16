import './setup';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  auditLogs,
  organizations,
  partnerApiIdempotencyKeys,
  partnerServicePrincipals,
  ticketComments,
  ticketExternalRefs,
  tickets,
} from '../../db/schema';
import { partnerApiRoutes } from '../../routes/partnerApi';
import {
  partnerTicketCommentWriteResponseSchema,
  partnerTicketRecordResponseSchema,
  partnerTicketWriteResponseSchema,
} from '../../routes/partnerApi/schemas';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import { moveTicketOrg } from '../../services/ticketService';
import type { PartnerServicePrincipalScope } from '../../services/partnerServicePrincipalScopes';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions, userEpochs } from './db-utils';
import { getTestDb } from './setup';

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  };
});

/**
 * Partner API ticket writes (tickets:write) against real Postgres, through
 * the real auth middleware and RLS as the non-BYPASSRLS app role.
 */
const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('partner API ticket writes', () => {
  runDb('creates, comments, transitions, assigns, updates and reads back — attributed to the principal, never a user', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const tech = await createUser({ partnerId: partner.id, email: `tech-${crypto.randomUUID()}@example.test` });
    const org = await createOrganization({ partnerId: partner.id });
    // Assignee eligibility = an active partner member with tickets:read who can reach the org.
    const techRole = await createRole({ partnerId: partner.id, scope: 'partner', name: `Tech ${crypto.randomUUID().slice(0, 6)}` });
    await grantRolePermissions(techRole.id, [{ resource: 'tickets', action: 'read' }]);
    await assignUserToPartner(tech.id, partner.id, techRole.id, 'all');
    const { rawKey, principalId } = await issueKey(partner.id, user.id, ['tickets:read', 'tickets:write']);
    const app = partnerApp();
    const admin = getTestDb();

    const created = await app.request('/tickets', {
      method: 'POST',
      headers: { ...jsonHeaders(rawKey), 'X-Idempotency-Key': 'psa-42' },
      body: JSON.stringify({
        orgId: org.id,
        subject: 'Opened from the PSA',
        description: 'Printer offline on floor 3',
        priority: 'high',
        dueDate: '2026-10-01T12:00:00.000Z',
        externalTicketId: 'PSA-42',
        externalTicketUrl: 'https://psa.example.com/t/42',
        submitterName: 'Jane Doe',
        submitterEmail: 'jane@example.test',
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = partnerTicketWriteResponseSchema.parse(await created.json());
    const ticketId = createdBody.id;
    expect(createdBody.data).toMatchObject({
      orgId: org.id, subject: 'Opened from the PSA', source: 'api', status: 'new', priority: 'high',
      externalTicketId: 'PSA-42', requester: { name: 'Jane Doe', email: 'jane@example.test' },
    });

    // Idempotent retry: same key + same body → 200, same id, no second ticket.
    const retry = await app.request('/tickets', {
      method: 'POST',
      headers: { ...jsonHeaders(rawKey), 'X-Idempotency-Key': 'psa-42' },
      body: JSON.stringify({
        orgId: org.id,
        subject: 'Opened from the PSA',
        description: 'Printer offline on floor 3',
        priority: 'high',
        dueDate: '2026-10-01T12:00:00.000Z',
        externalTicketId: 'PSA-42',
        externalTicketUrl: 'https://psa.example.com/t/42',
        submitterName: 'Jane Doe',
        submitterEmail: 'jane@example.test',
      }),
    });
    expect(retry.status, await retry.clone().text()).toBe(200);
    const retryBody = partnerTicketWriteResponseSchema.parse(await retry.json());
    expect(retryBody.id).toBe(ticketId);
    expect(retryBody.idempotencyReplay).toBe(true);

    // Same key, different body → 409.
    const reused = await app.request('/tickets', {
      method: 'POST',
      headers: { ...jsonHeaders(rawKey), 'X-Idempotency-Key': 'psa-42' },
      body: JSON.stringify({ orgId: org.id, subject: 'Something else' }),
    });
    expect(reused.status).toBe(409);
    expect((await reused.json() as { code: string }).code).toBe('partner_tickets_idempotency_key_reused');

    // Duplicate external id on a NEW ticket → 409 naming the existing one.
    const dup = await app.request('/tickets', {
      method: 'POST',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({ orgId: org.id, subject: 'Duplicate', externalTicketId: 'PSA-42' }),
    });
    expect(dup.status, await dup.clone().text()).toBe(409);
    const dupBody = await dup.json() as { code: string; details: { existingTicketId: string; existingDeleted: boolean } };
    expect(dupBody.code).toBe('EXTERNAL_ID_CONFLICT');
    expect(dupBody.details).toEqual({ externalTicketId: 'PSA-42', existingTicketId: ticketId, existingDeleted: false });
    // …and the conflicting create was rolled back with its ref: one ticket, one ref.
    expect(await admin.select().from(tickets).where(eq(tickets.orgId, org.id))).toHaveLength(1);
    const refs = await admin.select().from(ticketExternalRefs).where(eq(ticketExternalRefs.partnerServicePrincipalId, principalId));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ ticketId, orgId: org.id, externalId: 'PSA-42', externalUrl: 'https://psa.example.com/t/42' });
    // The legacy tickets columns are untouched: the ref is the principal's own row.
    const [afterCreate] = await admin.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(afterCreate?.externalTicketId).toBeNull();

    // Re-point this principal's ref (url kept), then clear it, then set it back.
    const repoint = await app.request(`/tickets/${ticketId}`, {
      method: 'PATCH', headers: jsonHeaders(rawKey), body: JSON.stringify({ externalTicketId: 'PSA-43' }),
    });
    expect(repoint.status, await repoint.clone().text()).toBe(200);
    expect(partnerTicketWriteResponseSchema.parse(await repoint.json()).data).toMatchObject({
      externalTicketId: 'PSA-43', externalTicketUrl: 'https://psa.example.com/t/42',
    });
    const cleared = await app.request(`/tickets/${ticketId}`, {
      method: 'PATCH', headers: jsonHeaders(rawKey), body: JSON.stringify({ externalTicketId: null }),
    });
    expect(cleared.status).toBe(200);
    expect(partnerTicketWriteResponseSchema.parse(await cleared.json()).data?.externalTicketId).toBeNull();
    expect(await admin.select().from(ticketExternalRefs).where(eq(ticketExternalRefs.ticketId, ticketId))).toHaveLength(0);
    const reset = await app.request(`/tickets/${ticketId}`, {
      method: 'PATCH', headers: jsonHeaders(rawKey), body: JSON.stringify({ externalTicketId: 'PSA-42', externalTicketUrl: 'https://psa.example.com/t/42' }),
    });
    expect(reset.status).toBe(200);

    const commented = await app.request(`/tickets/${ticketId}/comments`, {
      method: 'POST',
      headers: { ...jsonHeaders(rawKey), 'X-Idempotency-Key': 'note-1' },
      body: JSON.stringify({ content: 'Technician note mirrored from the PSA', isPublic: false }),
    });
    expect(commented.status, await commented.clone().text()).toBe(201);
    const commentBody = partnerTicketCommentWriteResponseSchema.parse(await commented.json());
    expect(commentBody.data).toMatchObject({
      isPublic: false, commentType: 'internal', originPrincipalKind: 'service_principal', originPrincipalId: principalId,
    });

    // The comment claim is bound to its ticket: the same key + body against
    // ANOTHER ticket is a fingerprint mismatch, never a replay of this note.
    const second = await app.request('/tickets', {
      method: 'POST', headers: jsonHeaders(rawKey), body: JSON.stringify({ orgId: org.id, subject: 'Second ticket' }),
    });
    expect(second.status).toBe(201);
    const secondId = partnerTicketWriteResponseSchema.parse(await second.json()).id;
    const wrongTicket = await app.request(`/tickets/${secondId}/comments`, {
      method: 'POST',
      headers: { ...jsonHeaders(rawKey), 'X-Idempotency-Key': 'note-1' },
      body: JSON.stringify({ content: 'Technician note mirrored from the PSA', isPublic: false }),
    });
    expect(wrongTicket.status).toBe(409);
    expect((await wrongTicket.json() as { code: string }).code).toBe('partner_tickets_idempotency_key_reused');
    expect(await admin.select().from(ticketComments).where(eq(ticketComments.ticketId, secondId))).toHaveLength(0);

    const assigned = await app.request(`/tickets/${ticketId}/assign`, {
      method: 'POST', headers: jsonHeaders(rawKey), body: JSON.stringify({ assigneeId: tech.id }),
    });
    expect(assigned.status, await assigned.clone().text()).toBe(200);
    expect(partnerTicketWriteResponseSchema.parse(await assigned.json()).data).toMatchObject({ assigneeId: tech.id, status: 'open' });

    const resolved = await app.request(`/tickets/${ticketId}/status`, {
      method: 'POST', headers: jsonHeaders(rawKey), body: JSON.stringify({ status: 'resolved', resolutionNote: 'Replaced the toner' }),
    });
    expect(resolved.status, await resolved.clone().text()).toBe(200);
    expect(partnerTicketWriteResponseSchema.parse(await resolved.json()).data).toMatchObject({ status: 'resolved', resolutionNote: 'Replaced the toner' });

    const patched = await app.request(`/tickets/${ticketId}`, {
      method: 'PATCH', headers: jsonHeaders(rawKey), body: JSON.stringify({ subject: 'Renamed by the PSA', tags: ['printer', 'floor-3'] }),
    });
    expect(patched.status, await patched.clone().text()).toBe(200);

    const readBack = await app.request(`/tickets/${ticketId}`, { headers: { 'X-API-Key': rawKey } });
    expect(readBack.status).toBe(200);
    const record = partnerTicketRecordResponseSchema.parse(await readBack.json()).data;
    expect(record).toMatchObject({ subject: 'Renamed by the PSA', tags: ['printer', 'floor-3'], status: 'resolved', assigneeId: tech.id });

    // Attribution in the database: no users(id) FK column names a person,
    // feed/comment rows are tagged service_principal, audit rows are api_key.
    const rows = await admin.select().from(ticketComments).where(eq(ticketComments.ticketId, ticketId));
    expect(rows.length).toBeGreaterThanOrEqual(4); // comment + assignment + status_change + system(update)
    for (const row of rows) {
      expect(row.userId).toBeNull();
      expect(row.portalUserId).toBeNull();
      expect(row.originPrincipalKind).toBe('service_principal');
    }
    const [stored] = await admin.select().from(tickets).where(eq(tickets.id, ticketId));
    expect(stored?.closedBy).toBeNull();
    expect(stored?.source).toBe('api');
    expect(stored?.fieldProvenance).toMatchObject({ subject: 'service_principal', tags: 'service_principal' });

    // Audit rows land asynchronously; poll briefly.
    const deadline = Date.now() + 10_000;
    let audits: Array<typeof auditLogs.$inferSelect> = [];
    while (Date.now() < deadline) {
      audits = await admin.select().from(auditLogs).where(and(eq(auditLogs.resourceId, ticketId), eq(auditLogs.resourceType, 'ticket')));
      if (audits.some((a) => a.action === 'ticket.create') && audits.some((a) => a.action === 'ticket.status_change')) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const ticketAudits = audits.filter((a) => a.action.startsWith('ticket.'));
    expect(ticketAudits.length).toBeGreaterThanOrEqual(4);
    for (const audit of ticketAudits) {
      expect(audit.actorType).toBe('api_key');
      expect(audit.initiatedBy).toBe('integration');
      expect((audit.details as Record<string, unknown>).partnerServicePrincipalId).toBe(principalId);
    }
    expect(JSON.stringify(audits)).not.toContain(rawKey);

    // Both claims are linked to what they created AND bound to the ticket they guard.
    const claims = await admin.select().from(partnerApiIdempotencyKeys).where(eq(partnerApiIdempotencyKeys.orgId, org.id));
    expect(claims.map((c) => [c.route, c.idempotencyKey, c.resourceId, c.ticketId])).toEqual(expect.arrayContaining([
      ['tickets.create', 'psa-42', ticketId, ticketId],
      ['tickets.comment', 'note-1', commentBody.id, ticketId],
    ]));
  });

  runDb('refuses a foreign org (403), another partner\'s ticket (404), a read-only scope (403), and RLS refuses a forged cross-partner claim', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const otherUser = await createUser({ partnerId: otherPartner.id });
    const foreignOrg = await createOrganization({ partnerId: otherPartner.id });
    const { rawKey, principalId } = await issueKey(partner.id, user.id, ['tickets:write']);
    const { rawKey: readOnlyKey } = await issueKey(partner.id, user.id, ['tickets:read']);
    const app = partnerApp();
    const admin = getTestDb();

    const foreign = await app.request('/tickets', {
      method: 'POST', headers: jsonHeaders(rawKey), body: JSON.stringify({ orgId: foreignOrg.id, subject: 'nope' }),
    });
    expect(foreign.status).toBe(403);
    expect((await foreign.json() as { code: string }).code).toBe('partner_tickets_org_access_denied');

    const [foreignTicket] = await admin.insert(tickets).values({
      orgId: foreignOrg.id, partnerId: otherPartner.id, subject: 'foreign', source: 'manual', priority: 'normal',
      ticketNumber: `F-${crypto.randomUUID().slice(0, 8)}`,
    }).returning({ id: tickets.id });
    for (const [path, body] of [
      [`/tickets/${foreignTicket!.id}`, { subject: 'x' }],
      [`/tickets/${foreignTicket!.id}/status`, { status: 'open' }],
      [`/tickets/${foreignTicket!.id}/assign`, { assigneeId: null }],
      [`/tickets/${foreignTicket!.id}/comments`, { content: 'x', isPublic: false }],
    ] as const) {
      const res = await app.request(path, {
        method: path.endsWith(foreignTicket!.id) ? 'PATCH' : 'POST', headers: jsonHeaders(rawKey), body: JSON.stringify(body),
      });
      expect(res.status, `${path} → ${await res.clone().text()}`).toBe(404);
    }
    const [untouched] = await admin.select().from(tickets).where(eq(tickets.id, foreignTicket!.id));
    expect(untouched?.subject).toBe('foreign');

    const readOnly = await app.request('/tickets', {
      method: 'POST', headers: jsonHeaders(readOnlyKey), body: JSON.stringify({ orgId: org.id, subject: 'nope' }),
    });
    expect(readOnly.status).toBe(403);

    // RLS, as breeze_app (the production `db` pool), in the partner-scoped
    // context a write handler opens: a claim for an organization outside the
    // accessible set is refused by the DATABASE (42501), not just by the
    // handler's allowlist check. The forged org belongs to the SAME partner,
    // so every foreign key is satisfiable and RLS is the only thing refusing.
    const unlistedOrg = await createOrganization({ partnerId: partner.id });
    const partnerContext = {
      scope: 'partner' as const, orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id],
      currentPartnerId: partner.id, userId: null,
    };
    const claim = (orgId: string, key: string) => withDbAccessContext(partnerContext, () =>
      db.insert(partnerApiIdempotencyKeys).values({
        partnerId: partner.id,
        partnerServicePrincipalId: principalId,
        orgId,
        route: 'tickets.create',
        idempotencyKey: key,
        requestFingerprint: 'a'.repeat(64),
      }).returning({ id: partnerApiIdempotencyKeys.id }),
    ).then((rows) => rows, (err: unknown) => err);
    // Positive control: the same insert for an accessible organization is admitted.
    expect(await claim(org.id, 'own-org')).toHaveLength(1);
    const forged = await claim(unlistedOrg.id, 'forged');
    expect(forged).toBeInstanceOf(Error);
    expect((forged as { cause?: { code?: string } }).cause?.code).toBe('42501');
    // And the database itself refuses a claim whose organization belongs to
    // another partner, even for the superuser: the composite FK, not RLS.
    const crossPartner = await admin.insert(partnerApiIdempotencyKeys).values({
      partnerId: partner.id,
      partnerServicePrincipalId: principalId,
      orgId: foreignOrg.id,
      route: 'tickets.create',
      idempotencyKey: 'cross-partner',
      requestFingerprint: 'a'.repeat(64),
    }).then(() => null, (err: unknown) => err);
    expect((crossPartner as { cause?: { code?: string } } | null)?.cause?.code).toBe('23503');
    void otherUser;
  });

  runDb('idempotency keys and external ids are scoped to the principal: two principals may use the same key string and the same external id', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id });
    const { rawKey } = await issueKey(partner.id, user.id, ['tickets:write']);
    const app = partnerApp();
    const admin = getTestDb();

    const a = await app.request('/tickets', {
      method: 'POST', headers: { ...jsonHeaders(rawKey), 'X-Idempotency-Key': 'shared-key' },
      body: JSON.stringify({ orgId: org.id, subject: 'A', externalTicketId: 'SHARED-1' }),
    });
    expect(a.status).toBe(201);
    const bKey = (await issueKey(partner.id, user.id, ['tickets:write'])).rawKey;
    // A different principal with the same key string gets its own claim.
    const b = await app.request('/tickets', {
      method: 'POST', headers: { ...jsonHeaders(bKey), 'X-Idempotency-Key': 'shared-key' },
      body: JSON.stringify({ orgId: org.id, subject: 'B', externalTicketId: 'SHARED-1' }),
    });
    expect(b.status, await b.clone().text()).toBe(201);
    expect(partnerTicketWriteResponseSchema.parse(await b.json()).id).not.toBe(partnerTicketWriteResponseSchema.parse(await a.clone().json().catch(() => ({ id: 'x' }))).id);

    // Both claims exist, one per principal, under the same key string.
    const claims = await admin.select().from(partnerApiIdempotencyKeys).where(eq(partnerApiIdempotencyKeys.orgId, org.id));
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((c) => c.partnerServicePrincipalId)).size).toBe(2);
    // Two refs for the same external id — one per principal — on two tickets.
    const refs = await admin.select().from(ticketExternalRefs).where(eq(ticketExternalRefs.externalId, 'SHARED-1'));
    expect(refs).toHaveLength(2);
    expect(new Set(refs.map((r) => r.ticketId)).size).toBe(2);
  });

  // #8235 review: a claim follows its ticket, so once the ticket leaves the
  // principal's organizations RLS hides the claim while the unique index still
  // holds the key. A retry must get the truthful answer, never "in flight".
  runDb('a key whose ticket left the principal\'s organizations answers 404 (create) or 409 reused (comment); an external-id 409 rolls its claim back', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const { rawKey, principalId } = await issueKey(partner.id, user.id, ['tickets:read', 'tickets:write']);
    const app = partnerApp();
    const admin = getTestDb();
    const post = (path: string, body: unknown, key?: string) => app.request(path, {
      method: 'POST',
      headers: { ...jsonHeaders(rawKey), ...(key ? { 'X-Idempotency-Key': key } : {}) },
      body: JSON.stringify(body),
    });

    const createBody = { orgId: orgA.id, subject: 'Moves away' };
    const created = await post('/tickets', createBody, 'moves-1');
    expect(created.status, await created.clone().text()).toBe(201);
    const ticketId = partnerTicketWriteResponseSchema.parse(await created.json()).id;
    const noteBody = { content: 'Mirrored note', isPublic: false };
    expect((await post(`/tickets/${ticketId}/comments`, noteBody, 'moves-note-1')).status).toBe(201);

    // A staff move takes the ticket, and both claims with it, to org B, which
    // is then suspended and so leaves the principal's accessible set.
    await withSystemDbAccessContext(() => moveTicketOrg(ticketId, orgB.id, { kind: 'user', userId: user.id }));
    await admin.update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, orgB.id));
    // Positive control: the claims still exist, under org B — hidden, not deleted.
    const claims = await admin.select({ orgId: partnerApiIdempotencyKeys.orgId })
      .from(partnerApiIdempotencyKeys)
      .where(eq(partnerApiIdempotencyKeys.partnerServicePrincipalId, principalId));
    expect(claims).toEqual([{ orgId: orgB.id }, { orgId: orgB.id }]);

    // The create retry asks for a ticket that left the principal's reach.
    const retry = await post('/tickets', createBody, 'moves-1');
    expect(retry.status, await retry.clone().text()).toBe(404);
    expect((await retry.json() as { code: string }).code).toBe('partner_ticket_not_found');

    // The comment key on another, accessible ticket: the key was reused.
    const stays = await post('/tickets', { orgId: orgA.id, subject: 'Stays' });
    const staysId = partnerTicketWriteResponseSchema.parse(await stays.json()).id;
    const reusedNote = await post(`/tickets/${staysId}/comments`, noteBody, 'moves-note-1');
    expect(reusedNote.status, await reusedNote.clone().text()).toBe(409);
    expect((await reusedNote.json() as { code: string }).code).toBe('partner_tickets_idempotency_key_reused');

    // An external-id 409 rolls the claim back with the ticket and its ref…
    expect((await post('/tickets', { orgId: orgA.id, subject: 'Holds EXT-1', externalTicketId: 'EXT-1' })).status).toBe(201);
    const conflict = await post('/tickets', { orgId: orgA.id, subject: 'Dup', externalTicketId: 'EXT-1' }, 'conflict-1');
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as { code: string }).code).toBe('EXTERNAL_ID_CONFLICT');
    expect(await admin.select().from(partnerApiIdempotencyKeys).where(and(
      eq(partnerApiIdempotencyKeys.partnerServicePrincipalId, principalId),
      eq(partnerApiIdempotencyKeys.idempotencyKey, 'conflict-1'),
    ))).toEqual([]);
    // …so the key is free: the corrected request creates, neither a replay nor a reuse.
    const fixed = await post('/tickets', { orgId: orgA.id, subject: 'Dup', externalTicketId: 'EXT-2' }, 'conflict-1');
    expect(fixed.status, await fixed.clone().text()).toBe(201);
    expect(partnerTicketWriteResponseSchema.parse(await fixed.json()).idempotencyReplay).toBeUndefined();
  });

  runDb('refuses an assignee from another partner, on create and on assign (400 ASSIGNEE_WRONG_PARTNER)', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const outsider = await createUser({ partnerId: otherPartner.id, email: `outsider-${crypto.randomUUID()}@example.test` });
    const { rawKey } = await issueKey(partner.id, user.id, ['tickets:read', 'tickets:write']);
    const app = partnerApp();
    const admin = getTestDb();

    const create = await app.request('/tickets', {
      method: 'POST', headers: jsonHeaders(rawKey),
      body: JSON.stringify({ orgId: org.id, subject: 'Cross-partner assignee', assigneeId: outsider.id }),
    });
    expect(create.status, await create.clone().text()).toBe(400);
    expect((await create.json() as { code: string }).code).toBe('ASSIGNEE_WRONG_PARTNER');
    expect(await admin.select().from(tickets).where(eq(tickets.orgId, org.id))).toHaveLength(0);

    const ok = await app.request('/tickets', {
      method: 'POST', headers: jsonHeaders(rawKey), body: JSON.stringify({ orgId: org.id, subject: 'Unassigned' }),
    });
    const ticketId = partnerTicketWriteResponseSchema.parse(await ok.json()).id;
    const assign = await app.request(`/tickets/${ticketId}/assign`, {
      method: 'POST', headers: jsonHeaders(rawKey), body: JSON.stringify({ assigneeId: outsider.id }),
    });
    expect(assign.status, await assign.clone().text()).toBe(400);
    expect((await assign.json() as { code: string }).code).toBe('ASSIGNEE_WRONG_PARTNER');
    const [row] = await admin.select({ assignedTo: tickets.assignedTo }).from(tickets).where(eq(tickets.id, ticketId));
    expect(row?.assignedTo).toBeNull();
  });
});

function partnerApp(): Hono {
  const app = new Hono();
  app.route('/', partnerApiRoutes);
  return app;
}

function jsonHeaders(rawKey: string): Record<string, string> {
  return { 'X-API-Key': rawKey, 'Content-Type': 'application/json' };
}

async function issueKey(
  partnerId: string,
  userId: string,
  scopes: readonly PartnerServicePrincipalScope[],
): Promise<{ rawKey: string; principalId: string }> {
  const admin = getTestDb();
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId,
    name: `Ticket write ${crypto.randomUUID()}`,
    scopes: [...scopes],
    createdBy: userId,
    updatedBy: userId,
  }).returning();
  if (!principal) throw new Error('service principal seed failed');
  const { rawKey } = await issuePartnerServicePrincipalKey(admin as unknown as Database, {
    partnerServicePrincipalId: principal.id,
    partnerId,
    name: 'Ticket write key',
    actorId: userId,
    actorSessionEpochs: await userEpochs(userId),
  });
  return { rawKey, principalId: principal.id };
}
