import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: {},
}));

vi.mock('../db/schema', () => ({
  mlFeedbackEvents: {},
  ticketCategories: {},
  tickets: {},
}));

vi.mock('./mlFeatureFlags', () => ({
  resolveMlFeatureFlagForOrg: vi.fn(),
}));

import { ticketTriageInternals } from './ticketTriage';

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
