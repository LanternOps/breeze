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
  status: 200,
}));

vi.mock('@breeze/shared/reportPdf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@breeze/shared/reportPdf')>()),
  buildReportPdf: (_rows: unknown[], opts: Record<string, unknown>) => {
    state.calls.push(opts);
    return { output: () => new Blob(['pdf'], { type: 'application/pdf' }) };
  },
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async () => new Response(JSON.stringify(state.partner), { status: state.status })),
}));

import { exportReport, loadPartnerBranding } from './reportExport';
import { serverBrandingFrom } from './serverBranding';

beforeEach(() => {
  state.calls.length = 0;
  state.status = 200;
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

describe('org-scoped browser export (#12048)', () => {
  const serverBranding = { name: 'Example MSP', logoDataUrl: 'data:image/png;base64,AAAA', logoAspect: 4, pageSize: 'letter' as const };
  const pdf = (extra: Record<string, unknown>) =>
    exportReport([{ hostname: 'WS-01' }], { format: 'pdf', reportType: 'device_inventory', timezone: 'UTC', ...extra });

  it('falls back to the API-resolved branding when /orgs/partners/me is forbidden', async () => {
    state.status = 403;
    await pdf({ serverBranding });
    expect(state.calls[0]?.branding).toMatchObject({ name: 'Example MSP', pageSize: 'letter', logoAspect: 4 });
  });

  it('prefers the partner branding when the caller can read it', async () => {
    state.partner = { name: 'Browser Partner', documentPageSize: 'a4', settings: {} };
    await pdf({ serverBranding });
    expect(state.calls[0]?.branding).toMatchObject({ name: 'Browser Partner', pageSize: 'a4' });
  });

  it('stays unbranded when neither source has branding', async () => {
    state.status = 403;
    await pdf({});
    expect(state.calls[0]?.branding).toMatchObject({ name: null, logoDataUrl: null });
  });

  it('accepts only a named branding object from the payload', () => {
    expect(serverBrandingFrom(serverBranding)).toBe(serverBranding);
    for (const bad of [undefined, null, 'x', 7, {}, { name: '' }, { name: 3 }]) expect(serverBrandingFrom(bad)).toBeUndefined();
  });
});
