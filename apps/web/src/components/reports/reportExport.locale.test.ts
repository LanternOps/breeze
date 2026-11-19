import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #12048: the staff/browser export prints on the partner's page size, in its
 * date format, with the generated time's timezone — the same as the portal and
 * emailed paths. Before, the browser pre-formatted "Nov 9, 2026, 12:06 PM"
 * (no zone) and every PDF was A4.
 */
const state = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  partner: {} as Record<string, unknown>,
}));

vi.mock('@breeze/shared/reportPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@breeze/shared/reportPdf')>()),
  buildReportPdf: (_rows: unknown[], opts: Record<string, unknown>) => {
    state.calls.push(opts);
    return { output: () => new Blob(['pdf'], { type: 'application/pdf' }) };
  },
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify(state.partner), { status: 200 })),
}));

import { exportReport, loadPartnerBranding } from './reportExport';

beforeEach(() => {
  state.calls.length = 0;
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', writable: true, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => undefined, writable: true, configurable: true });
});

describe('report export locale (#12048)', () => {
  it("loads the partner's page size, date format and time format with its branding", async () => {
    state.partner = {
      name: 'Example MSP',
      documentPageSize: 'letter',
      settings: { dateFormat: 'DD/MM/YYYY', timeFormat: '24h' },
    };
    expect(await loadPartnerBranding()).toMatchObject({
      name: 'Example MSP',
      pageSize: 'letter',
      dateFormat: 'DD/MM/YYYY',
      timeFormat: '24h',
    });
  });

  it('drops values the renderer does not know', async () => {
    state.partner = { name: 'Example MSP', documentPageSize: 'legal', settings: { dateFormat: 'D.M.Y', timeFormat: 'x' } };
    expect(await loadPartnerBranding()).toMatchObject({ pageSize: null, dateFormat: null, timeFormat: null });
  });

  it('hands the renderer the generation instant, not a pre-formatted string', async () => {
    const before = Date.now();
    await exportReport([{ hostname: 'WS-01' }], {
      format: 'pdf',
      reportType: 'device_inventory',
      timezone: 'America/New_York',
      branding: { name: 'Example MSP', logoDataUrl: null, logoAspect: null, pageSize: 'letter' },
    });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.generatedAt).toBeInstanceOf(Date);
    expect((state.calls[0]!.generatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(state.calls[0]!.timezone).toBe('America/New_York');
  });
});
