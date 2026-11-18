/**
 * The SCHEDULED-EMAIL render path for SLA performance (#11018). `emailReportRun`
 * casts `summary` through an untyped path into `buildReportPdf`, so a chain arm
 * that stopped matching would silently degrade the customer's attachment to the
 * generic row table, with the notes missing, while every other test stayed green.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SentEmail = { attachments?: Array<{ filename: string; content: Buffer }> };
const sendEmail = vi.fn(async (_payload: SentEmail) => undefined);
const captureException = vi.fn();
vi.mock('./sentry', () => ({ captureException: (err: unknown) => captureException(err) }));
vi.mock('./email', () => ({
  getEmailService: () => ({ sendEmail: (payload: SentEmail) => sendEmail(payload) }),
}));

import { emailReportRun } from './reportDelivery';
import { emptyTicketSlaPerformanceSummary, type TicketSlaPerformanceSummary } from '@breeze/shared';
import type { ReportBranding } from '@breeze/shared/reportPdf';

const branding: ReportBranding = { name: 'Breeze', logoDataUrl: null, logoAspect: null };

const summary: TicketSlaPerformanceSummary = {
  ...emptyTicketSlaPerformanceSummary('A report reflects ticket state when it was generated.'),
  period: {
    kind: 'last_full_month',
    start: '2026-10-01T00:00:00.000Z',
    end: '2026-11-01T00:00:00.000Z',
    label: 'October 2026',
    timeZone: 'America/Chicago',
    measuredThrough: '2026-11-01T00:00:00.000Z',
  },
  org: { orgId: 'o1', orgName: 'Acme Co' },
};

async function deliver(over: Partial<Parameters<typeof emailReportRun>[0]> = {}) {
  await emailReportRun({
    reportName: 'SLA performance',
    reportType: 'ticket_sla_performance',
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

describe('emailReportRun: ticket_sla_performance attachment', () => {
  it('emails a PDF named ticket_sla_performance', async () => {
    const sent = await deliver();
    const pdf = sent?.attachments?.[0];
    expect(pdf?.filename).toMatch(/ticket_sla_performance/);
    expect(pdf?.content.byteLength).toBeGreaterThan(0);

    const text = pdf!.content.toString('latin1');
    // Text only the designed renderer draws, and the notes it must carry.
    expect(text).toContain('Service Level Performance');
    expect(text).toContain('What this measures');
    expect(text).toContain('ticket state when it was generated');
  });

  it('a shape mismatch is captured, not thrown', async () => {
    captureException.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await deliver({ summary: { ...summary, period: null } as unknown as Record<string, unknown> });
    warn.mockRestore();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String((captureException.mock.calls[0]![0] as Error).message)).toMatch(/ticket_sla_performance.*summary_shape_mismatch/);
  });
});
