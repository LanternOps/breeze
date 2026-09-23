/**
 * The SCHEDULED-EMAIL render path for Ticket SLA attainment (#3198 W02 R1).
 *
 * Same reasoning as reportDelivery.threatDetection.test.ts: `emailReportRun`
 * casts `summary` through an untyped path into `buildReportPdf`, so nothing
 * here is type-checked against the ticket SLA shape, and a chain arm that
 * stopped matching would silently degrade the emailed attachment to
 * `renderGenericReport` — a plausible PDF with the whole designed body,
 * including the approximation notes, missing — while every other test stayed
 * green. This is the one apps/api test the drift report (§4 Task 10) calls
 * for proving the worker's business-report arms actually fire.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SentEmail = { attachments?: Array<{ filename: string; content: Buffer }> };
const sendEmail = vi.fn(async (_payload: SentEmail) => undefined);
vi.mock('./email', () => ({
  getEmailService: () => ({ sendEmail: (payload: SentEmail) => sendEmail(payload) }),
}));

import { emailReportRun } from './reportDelivery';
import type { TicketSlaSummary } from '@breeze/shared';
import type { ReportBranding } from '@breeze/shared/reportPdf';

const branding: ReportBranding = { name: 'Breeze', logoDataUrl: null, logoAspect: null };

const summary: TicketSlaSummary = {
  generatedAt: '2026-09-30T05:18:00.000Z',
  period: {
    kind: 'last_full_month',
    start: '2026-09-01T00:00:00.000Z',
    end: '2026-10-01T00:00:00.000Z',
    label: 'September 2026',
    timeZone: 'America/Chicago',
  },
  scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
  groupBy: 'priority',
  overall: {
    ticketsTotal: 12, noSlaTickets: 1, responseEligible: 11, responseMet: 10, responseAttainment: 10 / 11,
    resolutionEligible: 11, resolutionMet: 9, resolutionAttainment: 9 / 11, breaches: 2,
  },
  groups: [{
    groupKey: 'urgent', groupLabel: 'Urgent', ticketsTotal: 12, noSlaTickets: 1,
    responseEligible: 11, responseMet: 10, responseAttainment: 10 / 11,
    resolutionEligible: 11, resolutionMet: 9, resolutionAttainment: 9 / 11, breaches: 2,
  }],
  worstGroupLabel: 'Urgent',
  stampDiscrepancy: { recomputedBreachNotStamped: 1, stampedNotRecomputedBreach: 0 },
  detail: { cap: 5000, stored: 1, available: 1, truncated: false },
  notes: [
    'Attainment is recomputed from ticket timestamps and the SLA targets stored on each ticket, not from the sla_breached_at stamp.',
    'sla_paused_minutes is a lifetime total, so pause time that occurred after first response slightly flatters response attainment.',
    'Tickets with no SLA target are excluded from the attainment denominators and counted separately.',
    'Planned work (work_kind other than support) carries a due date, not an SLA, and is excluded.',
    "The technician axis uses the ticket's CURRENT assignee; reassignment history is not tracked.",
  ],
  rows: [{
    ticketId: 't1', ticketNumber: 'T-1', internalNumber: null, orgId: 'o1', orgName: 'Acme Co',
    subject: 'Server down', priority: 'urgent', category: 'infrastructure', assignedToName: 'Jamie Lee',
    createdAt: '2026-09-05T10:00:00.000Z', firstResponseAt: '2026-09-05T12:00:00.000Z',
    resolvedAt: '2026-09-06T10:00:00.000Z', responseSlaMinutes: 60, resolutionSlaMinutes: 480,
    slaPausedMinutes: 0, responseOutcome: 'missed', resolutionOutcome: 'met',
    stampedBreachAt: null, stampedBreachReason: null,
  }],
};

async function deliver(over: Partial<Parameters<typeof emailReportRun>[0]> = {}) {
  await emailReportRun({
    reportName: 'Ticket SLA attainment',
    reportType: 'ticket_sla_attainment',
    format: 'pdf',
    recipients: ['owner@example.com'],
    rows: [],
    summary: summary as unknown as Record<string, unknown>,
    timezone: 'UTC',
    branding,
    partnerId: null,
    ...over,
  });
  return sendEmail.mock.calls[0]?.[0];
}

beforeEach(() => sendEmail.mockClear());

describe('emailReportRun: ticket_sla_attainment attachment', () => {
  it('attaches a PDF rendered by the ticket SLA arm, not the generic table', async () => {
    const sent = await deliver();
    const pdf = sent?.attachments?.[0];
    expect(pdf?.filename).toMatch(/ticket_sla_attainment/);
    expect(pdf?.content.byteLength).toBeGreaterThan(0);

    const text = pdf!.content.toString('latin1');
    // Sections only the designed renderer draws.
    expect(text).toContain('Ticket SLA attainment');
    expect(text).toContain('What this measures');
    expect(text).toContain('Recompute vs stamped');
  });

  it('carries the approximation notes into the emailed artifact', async () => {
    const sent = await deliver();
    const text = sent!.attachments![0]!.content.toString('latin1');
    expect(text).toContain('lifetime total');
  });
});
