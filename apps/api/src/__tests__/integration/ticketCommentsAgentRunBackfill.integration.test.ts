/**
 * Replays 2026-10-08-100500-detach-ticket-comment-runs-on-device-org-move.sql
 * against a seeded ALREADY-STALE row -- the shape production data can already
 * have before this migration ever runs.
 *
 * CI databases are migrated schema-fresh in globalSetup, so this migration's
 * backfill has only ever run against ZERO rows there (every `RAISE WARNING`
 * in the CI log, if any fires at all, says "severed 0 ... pointer(s)"). A
 * green migration therefore says nothing about whether the backfill actually
 * finds and fixes a stale row -- see contactsBackfillMigration.integration.test.ts
 * for the same lesson applied to an earlier migration.
 *
 * Why a stale row can exist BEFORE this migration ever ships: addAiTriageNote()
 * (services/ticketService.ts, P2-4a #4300) has been a live, unflagged writer of
 * ticket_comments.agent_run_id since before this fix -- the #4644 issue's own
 * "nothing writes it yet" premise was wrong (see the corrected column comment
 * in db/schema/portal.ts and the migration's header). So a ticket that
 * received an AI-authored comment and then had its bound device moved to a
 * different org, on either axis, before the fix for that axis shipped
 * (#4642 ticket axis, this migration's device axis), already carries a stale
 * cross-org agent_run_id today, and only a backfill -- not just the trigger
 * fix -- reaches it.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/ticketCommentsAgentRunBackfill.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, ticketComments, tickets } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { sql } from 'drizzle-orm';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-08-100500-detach-ticket-comment-runs-on-device-org-move.sql',
);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

/** Replays the migration file as the privileged test role (idempotent: CREATE OR REPLACE + a re-runnable backfill). */
async function replayMigration() {
  await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
}

async function readComment(id: string) {
  const adminDb = getTestDb() as any;
  const [row] = await adminDb.select().from(ticketComments).where(eq(ticketComments.id, id));
  return row as typeof ticketComments.$inferSelect;
}

describe('ticket_comments.agent_run_id backfill (#4644 migration replay)', () => {
  it('severs an already-stale cross-org pointer, and leaves a same-org pointer alone', async () => {
    const adminDb = getTestDb() as any;

    // Source org: owns the run.
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const userA = await createUser({ partnerId: partnerA.id });
    const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(aiAgents)
        .values({ orgId: orgA.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: userA.id })
        .returning(),
    );
    // Two separate runs: ticket_comments_one_ai_note_per_run_uq permits at
    // most one ai_agent-authored comment per run, so the stale and control
    // comments below each need their own.
    const [staleRun, liveRun] = await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .insert(aiAgentRuns)
        .values([
          {
            agentId: agent!.id,
            orgId: orgA.id,
            triggerKind: 'ticket',
            dedupeKey: `backfill-stale-run-${randomUUID()}`,
            modeAtStart: 'shadow',
            policySnapshot: { schemaVersion: 1 } as never,
          },
          {
            agentId: agent!.id,
            orgId: orgA.id,
            triggerKind: 'ticket',
            dedupeKey: `backfill-live-run-${randomUUID()}`,
            modeAtStart: 'shadow',
            policySnapshot: { schemaVersion: 1 } as never,
          },
        ])
        .returning(),
    );

    // Target org: the ticket already lives here (simulating a move that
    // happened before either axis's severing fix shipped) — its parent org
    // no longer matches the run's org, which is exactly the staleness
    // condition the backfill targets. Directly constructed rather than
    // driven through the move routes: the backfill's WHERE clause is a pure
    // data-shape check (r.org_id IS DISTINCT FROM t.org_id via the ticket
    // join), indifferent to how the mismatch arose.
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    const siteB = await createSite({ orgId: orgB.id });
    const unique = randomUUID().slice(0, 8);
    const [staleTicket] = await adminDb
      .insert(tickets)
      .values({
        orgId: orgB.id,
        partnerId: partnerB.id,
        ticketNumber: `BACKFILL-STALE-${unique}`,
        subject: 'stale ticket fixture',
        source: 'manual',
      })
      .returning();
    const [staleComment] = await adminDb
      .insert(ticketComments)
      .values({
        ticketId: staleTicket.id,
        authorType: 'ai_agent',
        commentType: 'internal',
        content: 'AI note that outlived its ticket move.',
        isPublic: false,
        originPrincipalKind: 'ai_agent',
        agentRunId: staleRun!.id,
      })
      .returning();

    // Control: a comment on a ticket that STAYED in the run's own org. Must
    // survive the backfill untouched — rejects a backfill that nulls every
    // agent_run_id indiscriminately.
    const [liveTicket] = await adminDb
      .insert(tickets)
      .values({
        orgId: orgA.id,
        partnerId: partnerA.id,
        ticketNumber: `BACKFILL-LIVE-${unique}`,
        subject: 'live ticket fixture',
        source: 'manual',
      })
      .returning();
    const [liveComment] = await adminDb
      .insert(ticketComments)
      .values({
        ticketId: liveTicket.id,
        authorType: 'ai_agent',
        commentType: 'internal',
        content: 'AI note whose ticket never left.',
        isPublic: false,
        originPrincipalKind: 'ai_agent',
        agentRunId: liveRun!.id,
      })
      .returning();

    // Fixture guard: both pointers exist pre-replay.
    expect((await readComment(staleComment.id)).agentRunId).toBe(staleRun!.id);
    expect((await readComment(liveComment.id)).agentRunId).toBe(liveRun!.id);

    await replayMigration();

    expect((await readComment(staleComment.id)).agentRunId, 'stale cross-org pointer must be severed').toBeNull();
    expect(
      (await readComment(liveComment.id)).agentRunId,
      'same-org pointer must survive the backfill',
    ).toBe(liveRun!.id);

    // Idempotent replay: re-running must not error and must not touch the
    // already-corrected rows (there is nothing left to backfill).
    await replayMigration();
    expect((await readComment(staleComment.id)).agentRunId).toBeNull();
    expect((await readComment(liveComment.id)).agentRunId).toBe(liveRun!.id);
  });
});
