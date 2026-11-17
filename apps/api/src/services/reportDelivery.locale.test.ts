import { describe, expect, it, vi } from 'vitest';

/**
 * #12048: the emailed PDF passes the generation INSTANT to the renderer, which
 * prints it in the partner's date format with its timezone — the same as the
 * portal and staff paths. A pre-formatted en-US string here printed
 * "Nov 9, 2026, 12:06 PM" with no zone, beside reports that printed ISO dates.
 */
const state = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock('./email', () => ({ getEmailService: () => ({ sendEmail: vi.fn(async () => undefined) }) }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
vi.mock('@breeze/shared/reportPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@breeze/shared/reportPdf')>()),
  buildReportPdf: (_rows: unknown[], opts: Record<string, unknown>) => {
    state.calls.push(opts);
    return { output: () => new ArrayBuffer(8) };
  },
}));

import { emailReportRun } from './reportDelivery';

describe('emailed report PDF locale (#12048)', () => {
  it('hands the renderer the generation instant and the partner branding with its page size', async () => {
    const before = Date.now();
    await emailReportRun({
      reportName: 'Monthly posture',
      reportType: 'security_compliance_posture',
      format: 'pdf',
      recipients: ['ops@example.com'],
      rows: [],
      timezone: 'America/New_York',
      branding: { name: 'Acme', logoDataUrl: null, logoAspect: null, pageSize: 'letter', dateFormat: 'MM/DD/YYYY', timeFormat: '12h' },
      partnerId: null,
    });
    expect(state.calls).toHaveLength(1);
    const opts = state.calls[0]!;
    expect(opts.generatedAt).toBeInstanceOf(Date);
    expect((opts.generatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(opts.timezone).toBe('America/New_York');
    expect(opts.branding).toMatchObject({ pageSize: 'letter', dateFormat: 'MM/DD/YYYY', timeFormat: '12h' });
  });
});
