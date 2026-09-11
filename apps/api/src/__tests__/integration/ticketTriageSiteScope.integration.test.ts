/**
 * SEC-022: ticket-triage evaluation must honor the staff caller's site ceiling.
 *
 * The aggregate reads ml_feedback_events, which is org-scoped by RLS but has no
 * site column. These tests therefore exercise the real source-ticket/device
 * relationship through the unprivileged breeze_app connection. Positive and
 * denial controls live in one fixture so a hidden-site label cannot disappear
 * merely because tenant RLS, time-window filtering, or event filtering failed.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { withDbAccessContext, type DbAccessContext } from '../../db';
import { devices, mlFeedbackEvents, tickets } from '../../db/schema';
import { evaluateTicketTriage } from '../../services/ticketTriage';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

describe('ticket triage evaluation site scope (breeze_app)', () => {
  it('includes visible and deviceless sources while denying hidden, deleted, and missing sources', async () => {
    const adminDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const actor = await createUser({ partnerId: partner.id, orgId: org.id });
    const visibleSite = await createSite({ orgId: org.id, name: 'Visible site' });
    const hiddenSite = await createSite({ orgId: org.id, name: 'Hidden site' });

    const [visibleDevice, hiddenDevice] = await adminDb.insert(devices).values([
      {
        orgId: org.id,
        siteId: visibleSite.id,
        agentId: `sec022-visible-${randomUUID()}`,
        hostname: 'sec022-visible',
        displayName: 'SEC022 visible',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x86_64',
        agentVersion: 'test',
        status: 'online',
        enrolledAt: new Date(),
      },
      {
        orgId: org.id,
        siteId: hiddenSite.id,
        agentId: `sec022-hidden-${randomUUID()}`,
        hostname: 'sec022-hidden',
        displayName: 'SEC022 hidden',
        osType: 'linux',
        osVersion: 'test',
        architecture: 'x86_64',
        agentVersion: 'test',
        status: 'online',
        enrolledAt: new Date(),
      },
    ]).returning({ id: devices.id });

    const now = new Date();
    const [visibleTicket, hiddenTicket, devicelessTicket, deletedTicket] = await adminDb
      .insert(tickets)
      .values([
        { orgId: org.id, partnerId: partner.id, ticketNumber: `SEC022-V-${randomUUID()}`, subject: 'visible', source: 'manual', deviceId: visibleDevice!.id },
        { orgId: org.id, partnerId: partner.id, ticketNumber: `SEC022-H-${randomUUID()}`, subject: 'hidden', source: 'manual', deviceId: hiddenDevice!.id },
        { orgId: org.id, partnerId: partner.id, ticketNumber: `SEC022-DL-${randomUUID()}`, subject: 'deviceless', source: 'manual', deviceId: null },
        { orgId: org.id, partnerId: partner.id, ticketNumber: `SEC022-X-${randomUUID()}`, subject: 'deleted', source: 'manual', deviceId: visibleDevice!.id, deletedAt: now },
      ])
      .returning({ id: tickets.id });

    await adminDb.insert(mlFeedbackEvents).values([
      { orgId: org.id, sourceType: 'ticket', sourceId: visibleTicket!.id, eventType: 'ticket.priority_changed', outcome: 'priority_changed', metadata: { acceptedSuggestion: true }, occurredAt: now },
      { orgId: org.id, sourceType: 'ticket', sourceId: hiddenTicket!.id, eventType: 'ticket.priority_changed', outcome: 'priority_changed', metadata: {}, occurredAt: now },
      { orgId: org.id, sourceType: 'ticket', sourceId: devicelessTicket!.id, eventType: 'ticket.category_changed', outcome: 'category_changed', metadata: {}, occurredAt: now },
      { orgId: org.id, sourceType: 'ticket', sourceId: deletedTicket!.id, eventType: 'ticket.assignee_changed', outcome: 'assignee_changed', metadata: {}, occurredAt: now },
      { orgId: org.id, sourceType: 'ticket', sourceId: randomUUID(), eventType: 'ticket.triage_rejected', outcome: 'rejected', metadata: {}, occurredAt: now },
      { orgId: org.id, sourceType: 'ticket', sourceId: 'malformed-ticket-id', eventType: 'ticket.triage_rejected', outcome: 'rejected', metadata: {}, occurredAt: now },
    ]);

    const context: DbAccessContext = {
      scope: 'organization',
      orgId: org.id,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [],
      userId: actor.id,
    };
    const input = { orgIds: [org.id], labelWindowDays: 30, allowedSiteIds: [visibleSite.id] };

    const restricted = await withDbAccessContext(context, () => evaluateTicketTriage(input));
    expect(restricted).toMatchObject({
      totalLabels: 2,
      acceptedSuggestionLabels: 1,
      manualOverrideLabels: 1,
      categoryLabels: 1,
      priorityLabels: 1,
      assigneeLabels: 0,
      rejectedSuggestionLabels: 0,
    });

    const zeroSite = await withDbAccessContext(context, () =>
      evaluateTicketTriage({ ...input, allowedSiteIds: [] }),
    );
    expect(zeroSite).toMatchObject({ totalLabels: 1, categoryLabels: 1, priorityLabels: 0 });

    const unrestricted = await withDbAccessContext(context, () =>
      evaluateTicketTriage({ orgIds: [org.id], labelWindowDays: 30 }),
    );
    expect(unrestricted.totalLabels).toBe(6);
  });
});
