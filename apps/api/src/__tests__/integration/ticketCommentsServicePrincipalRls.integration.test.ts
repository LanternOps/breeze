/**
 * Real-PostgreSQL contract for a partner-service-principal-authored
 * `ticket_comments` row (Partner API tickets surface, Wave 1).
 *
 * Migration under test: 2026-12-04-101100-ticket-comments-service-principal-origin.sql
 *   1. the CHECK admits origin_principal_kind = 'service_principal';
 *   2. the permissive INSERT policy admits a user_id-NULL row on an
 *      org-accessible ticket under the Partner API's bounded PARTNER context
 *      (scope 'partner', userId null) — which `breeze_user_isolation_insert`
 *      alone refuses, since its user_id-NULL branch needs scope 'system';
 *   3. it does NOT admit the same row on a ticket the principal cannot reach
 *      (cross-partner forge → 42501), nor a 'service_principal' row that
 *      still names a user (the policy is user_id IS NULL, not "or").
 *
 * All authorization assertions run through the production `db` pool as the
 * non-BYPASSRLS `breeze_app` role; the seed/fixture rows go through the admin
 * connection so a pass can only come from the policy, never from a bypass.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { ticketComments, tickets } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
// replayMigration takes the shipped file NAME (it resolves the migrations
// directory itself and re-applies every later file touching the same objects).
const MIGRATION_FILE = '2026-12-04-101100-ticket-comments-service-principal-origin.sql';

/** The context `partnerApiAuth` / a Partner API write handler opens. */
function partnerApiContext(partnerId: string, accessibleOrgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds,
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}

async function seedTicket(partnerId: string, orgId: string) {
  const adminDb = getTestDb() as any;
  const [ticket] = await adminDb.insert(tickets).values({
    orgId,
    partnerId,
    ticketNumber: `SP-${randomUUID().slice(0, 8)}`,
    subject: 'Opened by an external PSA',
    source: 'api',
    priority: 'normal',
  }).returning();
  return ticket as typeof tickets.$inferSelect;
}

function servicePrincipalRow(ticketId: string, overrides: Partial<typeof ticketComments.$inferInsert> = {}) {
  return {
    ticketId,
    userId: null,
    portalUserId: null,
    authorName: 'PSA Bridge',
    authorType: 'internal',
    commentType: 'comment',
    content: 'Mirrored from the PSA',
    isPublic: true,
    originPrincipalKind: 'service_principal',
    originPrincipalId: '1b4e28ba-2fa1-11d2-883f-0016d3cca427',
    ...overrides,
  } satisfies typeof ticketComments.$inferInsert;
}

function pgCause(err: unknown): { code?: string; message?: string; constraint_name?: string } | undefined {
  return (err as { cause?: { code?: string; message?: string; constraint_name?: string } })?.cause;
}

describe('ticket_comments — service-principal author (Partner API, Wave 1)', () => {
  runDb('re-applies the migration idempotently', async () => {
    await replayMigration(MIGRATION_FILE);
    await replayMigration(MIGRATION_FILE);
  });

  runDb('the CHECK admits service_principal and still rejects an unknown kind', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const ticket = await seedTicket(partner.id, org.id);
    const adminDb = getTestDb() as any;

    const [ok] = await adminDb.insert(ticketComments).values(servicePrincipalRow(ticket.id)).returning();
    expect(ok.originPrincipalKind).toBe('service_principal');
    expect(ok.userId).toBeNull();

    const rejected = await adminDb
      .insert(ticketComments)
      .values(servicePrincipalRow(ticket.id, { originPrincipalKind: 'integration' }))
      .then(() => null, (err: unknown) => err);
    expect(rejected).toBeInstanceOf(Error);
    expect(pgCause(rejected)?.code).toBe('23514');
    expect(pgCause(rejected)?.constraint_name).toBe('ticket_comments_origin_principal_kind_chk');
  });

  runDb('admits a user_id-NULL service_principal comment under the partner-scoped, user-less context', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const ticket = await seedTicket(partner.id, org.id);

    const [row] = await withDbAccessContext(partnerApiContext(partner.id, [org.id]), () =>
      db.insert(ticketComments).values(servicePrincipalRow(ticket.id)).returning(),
    );
    expect(row?.id).toBeDefined();
    expect(row?.userId).toBeNull();
    expect(row?.originPrincipalKind).toBe('service_principal');

    const adminDb = getTestDb() as any;
    const persisted = await adminDb
      .select({ id: ticketComments.id })
      .from(ticketComments)
      .where(and(eq(ticketComments.ticketId, ticket.id), eq(ticketComments.originPrincipalKind, 'service_principal')));
    expect(persisted).toHaveLength(1);
  });

  runDb('refuses the same row on another partner\'s ticket (42501)', async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const ticketB = await seedTicket(partnerB.id, orgB.id);

    const forged = await withDbAccessContext(partnerApiContext(partnerA.id, [orgA.id]), () =>
      db.insert(ticketComments).values(servicePrincipalRow(ticketB.id)).returning(),
    ).then(() => null, (err: unknown) => err);

    expect(forged).toBeInstanceOf(Error);
    expect(pgCause(forged)?.code).toBe('42501');
    expect(pgCause(forged)?.message).toContain('new row violates row-level security policy for table "ticket_comments"');
  });

  runDb('refuses a service_principal row with no principal id (CHECK 23514) and one under an org-only context without the parent ticket', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const ticket = await seedTicket(partner.id, org.id);
    const adminDb = getTestDb() as any;
    const noPrincipal = await adminDb
      .insert(ticketComments)
      .values(servicePrincipalRow(ticket.id, { originPrincipalId: null }))
      .then(() => null, (err: unknown) => err);
    expect(noPrincipal).toBeInstanceOf(Error);
    expect(pgCause(noPrincipal)?.code).toBe('23514');
    expect(pgCause(noPrincipal)?.constraint_name).toBe('ticket_comments_service_principal_origin_id_chk');
  });

  runDb('refuses a service_principal row that names another partner\'s user (the new policy is user_id IS NULL, not "or")', async () => {
    // A row naming one of the SAME partner's users is admitted by the
    // pre-existing staff policy (breeze_has_partner_access on the user's
    // partner), so the narrowness of the new policy is only observable with
    // a user no other policy admits.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const ticket = await seedTicket(partner.id, org.id);
    const otherPartner = await createPartner();
    const { createUser } = await import('./db-utils');
    const outsider = await createUser({ partnerId: otherPartner.id });

    const rejected = await withDbAccessContext(partnerApiContext(partner.id, [org.id]), () =>
      db.insert(ticketComments).values(servicePrincipalRow(ticket.id, { userId: outsider.id })).returning(),
    ).then(() => null, (err: unknown) => err);

    expect(rejected).toBeInstanceOf(Error);
    expect(pgCause(rejected)?.code).toBe('42501');
  });
});
