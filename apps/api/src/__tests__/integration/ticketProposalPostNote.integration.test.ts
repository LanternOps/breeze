/**
 * Live-Postgres proof for W01 (#4211) — the ticket-detail "Post as private
 * note" flow. Verifies against REAL rows, not mocked `../db`, three
 * properties a unit suite with a fully-stubbed `db` cannot exercise:
 *
 *  1. `postProposalNote` (ticketService.ts) writes a `ticket_comments` row
 *     that is human-origin (`origin_principal_kind='user'`, `user_id` set,
 *     `agent_run_id` NULL) but still carries `proposed_by_run_id` — the new
 *     W01 provenance column, live against the real RLS policies and the
 *     `ticket_comments_proposed_by_run_id_fkey` FK to `ai_agent_runs`.
 *  2. The row that lands is invisible to the helpdesk loop guard's own query
 *     shape (`ticketHasAgentOriginatedActivity`, ticketHelpdeskSubscriber.ts —
 *     not exported, so this asserts the SAME predicate it runs) — proving the
 *     migration-header claim that `proposed_by_run_id` cannot trip the guard.
 *  3. `moveTicketOrg` (Task 2, #4211) drops `proposed_by_run_id` on a
 *     cross-org move in the SAME statement as the pre-existing `agent_run_id`
 *     detach — live against the real UPDATE, not a mocked `.set()` call.
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up — see aiAgentTicketTriage.integration.test.ts's header for
 * the full "anywhere else runs in ZERO CI jobs" rationale.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { and, eq, isNotNull, ne, or } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, ticketComments, tickets } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { postProposalNote, moveTicketOrg } from '../../services/ticketService';

async function seedTicketWithProposal() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const technician = await createUser({
    partnerId: partner.id,
    email: `w01-tech-${randomUUID()}@ticket-proposal.test`,
  });

  const [agent] = await withSystemDbAccessContext(() =>
    db.insert(aiAgents).values({
      orgId: org.id,
      partnerId: null,
      kind: 'helpdesk',
      name: 'W01 Test Agent',
      createdBy: technician.id,
    }).returning(),
  );

  const [ticket] = await withSystemDbAccessContext(() =>
    db.insert(tickets).values({
      orgId: org.id,
      partnerId: partner.id,
      ticketNumber: `W01-${randomUUID().slice(0, 8)}`,
      subject: 'Printer spooler crashing',
      source: 'manual',
    }).returning(),
  );

  const [run] = await withSystemDbAccessContext(() =>
    db.insert(aiAgentRuns).values({
      agentId: agent!.id,
      orgId: org.id,
      ticketId: ticket!.id,
      profile: 'triage',
      status: 'completed',
      triggerKind: 'ticket',
      dedupeKey: `w01-proposal-${randomUUID()}`,
      modeAtStart: 'shadow',
      policySnapshot: {} as never,
      finishedAt: new Date(),
      outcome: {
        ticketProposal: {
          version: 1,
          summary: 'Printer spooler wedged; restarted the service.',
        },
      },
    }).returning(),
  );

  return { partner, org, technician, ticket: ticket!, run: run! };
}

describe('postProposalNote — live Postgres (#4211)', () => {
  it('a technician-posted proposal note is human-origin, private, and run-linked', async () => {
    const { ticket, run, technician } = await seedTicketWithProposal();

    await withSystemDbAccessContext(() =>
      postProposalNote(ticket.id, run.id, 'Spooler wedged; restarted the service.', {
        userId: technician.id,
        name: technician.name,
      }),
    );

    const adminDb = getTestDb() as any;
    const [row] = await adminDb.select().from(ticketComments).where(eq(ticketComments.ticketId, ticket.id));
    expect(row.originPrincipalKind).toBe('user');
    expect(row.userId).toBe(technician.id);
    expect(row.agentRunId).toBeNull();
    expect(row.proposedByRunId).toBe(run.id);
    expect(row.isPublic).toBe(false);
    expect(row.commentType).toBe('internal');
  });

  it('#4211 review: a duplicate call for the SAME run recovers via the unique index instead of duplicating the note', async () => {
    const { ticket, run, technician } = await seedTicketWithProposal();
    const actor = { userId: technician.id, name: technician.name };

    const first = await withSystemDbAccessContext(() =>
      postProposalNote(ticket.id, run.id, 'Spooler wedged; restarted the service.', actor),
    );
    const second = await withSystemDbAccessContext(() =>
      postProposalNote(ticket.id, run.id, 'Spooler wedged; restarted the service.', actor),
    );

    expect(second.comment.id).toBe(first.comment.id);

    const adminDb = getTestDb() as any;
    const rows = await adminDb.select().from(ticketComments).where(eq(ticketComments.ticketId, ticket.id));
    expect(rows).toHaveLength(1);
  });

  it('the helpdesk loop guard still sees the ticket as human-only', async () => {
    const { ticket, run, technician } = await seedTicketWithProposal();

    await withSystemDbAccessContext(() =>
      postProposalNote(ticket.id, run.id, 'Spooler wedged; restarted the service.', {
        userId: technician.id,
        name: technician.name,
      }),
    );

    // ticketHasAgentOriginatedActivity (ticketHelpdeskSubscriber.ts) is not
    // exported, so this asserts its query SHAPE directly: any row that is
    // NOT origin_principal_kind='user' OR carries a non-null agent_run_id
    // would trip the guard. A row with proposed_by_run_id set but
    // agent_run_id NULL and origin_principal_kind='user' must NOT match.
    const adminDb = getTestDb() as any;
    const hit = await adminDb
      .select({ id: ticketComments.id })
      .from(ticketComments)
      .where(and(
        eq(ticketComments.ticketId, ticket.id),
        or(ne(ticketComments.originPrincipalKind, 'user'), isNotNull(ticketComments.agentRunId)),
      ))
      .limit(1);
    expect(hit).toHaveLength(0);
  });

  it('404s when the run does not belong to this ticket', async () => {
    const { ticket, technician } = await seedTicketWithProposal();
    const otherTicketScenario = await seedTicketWithProposal();

    await expect(
      withSystemDbAccessContext(() =>
        postProposalNote(ticket.id, otherTicketScenario.run.id, 'x', { userId: technician.id }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a cross-org move drops proposed_by_run_id in the same statement as agent_run_id', async () => {
    const { partner, org, ticket, run, technician } = await seedTicketWithProposal();
    const targetOrg = await createOrganization({ partnerId: partner.id });

    const { comment } = await withSystemDbAccessContext(() =>
      postProposalNote(ticket.id, run.id, 'Spooler wedged; restarted the service.', {
        userId: technician.id,
        name: technician.name,
      }),
    );

    const adminDb = getTestDb() as any;
    const [beforeMove] = await adminDb.select().from(ticketComments).where(eq(ticketComments.id, comment.id));
    expect(beforeMove.proposedByRunId).toBe(run.id);

    await withSystemDbAccessContext(() =>
      moveTicketOrg(ticket.id, targetOrg.id, { userId: technician.id, name: technician.name }, {}),
    );

    const [afterMove] = await adminDb.select().from(ticketComments).where(eq(ticketComments.id, comment.id));
    expect(afterMove.proposedByRunId).toBeNull();
    expect(afterMove.agentRunId).toBeNull();

    const [movedTicket] = await adminDb.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(movedTicket.orgId).toBe(targetOrg.id);
  });
});
