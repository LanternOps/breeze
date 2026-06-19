import { describe, expect, it, vi, beforeEach } from 'vitest';

// Categories returned by the mocked db.select chain; mutated per-test.
let categoryRows: Array<{ id: string; name: string; defaultPriority: string | null }> = [];

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(categoryRows),
      }),
    }),
  },
}));

vi.mock('../db/schema', () => ({
  mlFeedbackEvents: {},
  ticketCategories: {},
  tickets: {},
}));

vi.mock('./mlFeatureFlags', () => ({
  resolveMlFeatureFlagForOrg: vi.fn(),
}));

import { getTicketTriageSuggestion, ticketTriageInternals } from './ticketTriage';
import { resolveMlFeatureFlagForOrg } from './mlFeatureFlags';

const baseTicket = {
  id: 'ticket-1',
  orgId: 'org-1',
  partnerId: 'partner-1',
  subject: 'VPN is down for the whole office',
  description: 'Nobody can connect to the VPN',
  source: 'email',
  priority: 'normal',
  categoryId: null,
} as unknown as Parameters<typeof getTicketTriageSuggestion>[0];

describe('getTicketTriageSuggestion — empty-category explanation', () => {
  beforeEach(() => {
    categoryRows = [];
    vi.mocked(resolveMlFeatureFlagForOrg).mockResolvedValue({ enabled: true, source: 'test' } as never);
  });

  it('records no_partner_categories when the ticket has no partner', async () => {
    const result = await getTicketTriageSuggestion({ ...baseTicket, partnerId: null } as never);
    expect(result.suggestion).not.toBeNull();
    expect(result.suggestion?.reasons).toContain('no_partner_categories');
    expect(result.suggestion?.categoryId).toBeNull();
  });

  it('records no_active_partner_categories when the partner has no active categories', async () => {
    categoryRows = [];
    const result = await getTicketTriageSuggestion(baseTicket);
    expect(result.suggestion?.reasons).toContain('no_active_partner_categories');
  });

  it('records no_category_keyword_match when categories exist but none match', async () => {
    categoryRows = [{ id: 'cat-backup', name: 'Backup', defaultPriority: null }];
    const result = await getTicketTriageSuggestion(baseTicket);
    expect(result.suggestion?.reasons).toContain('no_category_keyword_match');
  });
});

describe('ticketTriageInternals', () => {
  it('suggests urgent priority for outage/security language', () => {
    expect(ticketTriageInternals.suggestTicketPriority('ransomware breach on server')).toMatchObject({
      priority: 'urgent',
      reason: 'critical-impact keywords',
    });
    expect(ticketTriageInternals.suggestTicketPriority('email is down for everyone')).toMatchObject({
      priority: 'urgent',
    });
  });

  it('chooses matching category from ticket text', () => {
    const category = ticketTriageInternals.chooseTicketCategory('printer is offline and jammed', [
      { id: 'cat-network', name: 'Network', defaultPriority: null },
      { id: 'cat-hardware', name: 'Hardware', defaultPriority: 'high' },
    ]);

    expect(category).toMatchObject({ id: 'cat-hardware', defaultPriority: 'high' });
  });

  it('computes override rate from accepted suggestion and manual labels', () => {
    const summary = ticketTriageInternals.computeTicketTriageEvaluationSummary([
      { eventType: 'ticket.priority_changed', metadata: { acceptedSuggestion: true } },
      { eventType: 'ticket.category_changed', metadata: { acceptedSuggestion: false } },
      { eventType: 'ticket.assignee_changed', metadata: { source: 'manual_update' } },
      { eventType: 'ticket.triage_rejected', metadata: { acceptedSuggestion: false } },
    ], 90);

    expect(summary).toEqual(expect.objectContaining({
      totalLabels: 4,
      acceptedSuggestionLabels: 1,
      manualOverrideLabels: 3,
      rejectedSuggestionLabels: 1,
      categoryLabels: 1,
      priorityLabels: 1,
      assigneeLabels: 1,
      overrideRate: 0.75,
    }));
  });
});
