/**
 * Tool Catalog W06 (#5221) Task C2 — "Move to Flows" on the Jobs page.
 *
 * The panel follows `#convert-<automationId>`; a switched Job is read-only with
 * a link to its flow; the column, the banner and "New job → Flows" exist only
 * while Flows are enabled; write actions need `automations.write`.
 */
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: vi.fn() };
});
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const gate = vi.hoisted(() => ({ value: { enabled: true, loaded: true } }));
vi.mock('../../stores/featuresStore', () => ({ useFlowsGate: () => gate.value }));
const perms = vi.hoisted(() => ({ write: true }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => r === 'automations' && (a === 'read' || perms.write) }),
}));
const conv = vi.hoisted(() => ({
  listConversions: vi.fn(),
  previewConversion: vi.fn(),
  getConversion: vi.fn(),
}));
vi.mock('./conversion/conversionApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./conversion/conversionApi')>()),
  ...conv,
}));
vi.mock('../flows/api', () => ({ getFlow: vi.fn() }));

import AutomationsPage from './AutomationsPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const base = {
  orgId: 'org-1', enabled: true, trigger: { type: 'schedule', cron: '0 2 * * *' }, actions: [],
  createdAt: '2026-08-24T12:00:00.000Z', updatedAt: '2026-08-24T12:00:00.000Z',
};
const ROWS = [
  { ...base, id: 'a-1', name: 'Nightly cleanup', conversion: null },
  { ...base, id: 'a-2', name: 'Disk report', enabled: false, conversion: { id: 'c-2', state: 'switched', flowId: 'f-2' } },
  { ...base, id: 'a-3', name: 'Patch check', conversion: { id: 'c-3', state: 'shadow', flowId: 'f-3' } },
];

beforeEach(() => {
  gate.value = { enabled: true, loaded: true };
  perms.write = true;
  window.location.hash = '';
  fetchMock.mockReset().mockImplementation(async () => json({ data: ROWS }));
  conv.listConversions.mockReset().mockImplementation(async ({ state }: { state: string }) => ({
    conversions: state === 'shadow'
      ? [{ id: 'c-3', automationId: 'a-3', flowId: 'f-3', state: 'shadow', fidelity: 'needs_review', findings: [] }]
      : [],
    total: 0,
  }));
  conv.previewConversion.mockReset().mockResolvedValue({
    automationId: 'a-1', fidelity: 'exact', findings: [], document: null, preApprovalCandidates: [],
    generatedScripts: [], sourceDigest: 'd'.repeat(64), documentDigest: null, targetCount: 1, estimatedMonthlyRuns: 1,
  });
  conv.getConversion.mockReset();
});
afterEach(() => {
  window.location.hash = '';
});

describe('AutomationsPage — Move to Flows (#5221)', () => {
  it('panel follows #convert-<id>', async () => {
    window.location.hash = '#convert-a-1';
    render(<AutomationsPage />);
    const panel = await screen.findByTestId('conversion-panel');
    expect(panel.getAttribute('data-automation-id')).toBe('a-1');
    await waitFor(() => expect(conv.previewConversion).toHaveBeenCalledWith('a-1'));

    fireEvent.click(screen.getByTestId('conversion-panel-close'));
    await waitFor(() => expect(screen.queryByTestId('conversion-panel')).toBeNull());
    expect(window.location.hash).toBe('#all');
  });

  it('the Move button writes #convert-<id> and opens the panel', async () => {
    render(<AutomationsPage />);
    fireEvent.click(await screen.findByTestId('automation-move-a-1'));
    expect(window.location.hash).toBe('#convert-a-1');
    expect(await screen.findByTestId('conversion-panel')).toBeTruthy();
  });

  it('a live conversion shows its fidelity badge in the column', async () => {
    render(<AutomationsPage />);
    const cell = await screen.findByTestId('automation-move-cell-a-3');
    await waitFor(() => expect(within(cell).getByTestId('conversion-fidelity-badge').textContent).toBe('Needs review'));
  });

  it('switched row is read-only with a flow link', async () => {
    render(<AutomationsPage />);
    const link = await screen.findByTestId('automation-moved-link-a-2');
    expect(link.getAttribute('href')).toBe('/flows/f-2');
    expect((screen.getByTestId('automation-toggle-a-2') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('automation-run-a-2') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('automation-edit-a-2') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('automation-menu-a-2'));
    expect((screen.getByTestId('automation-delete-a-2') as HTMLButtonElement).disabled).toBe(true);
    // An unswitched row stays editable.
    expect((screen.getByTestId('automation-edit-a-1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('with Flows on, New job opens Flows and the R1 banner shows', async () => {
    render(<AutomationsPage />);
    expect(await screen.findByTestId('jobs-migration-banner')).toBeTruthy();
    expect(screen.getByTestId('automations-new').getAttribute('href')).toBe('/flows');
  });

  it('no write permission hides actions', async () => {
    perms.write = false;
    window.location.hash = '#convert-a-1';
    render(<AutomationsPage />);
    expect(await screen.findByTestId('jobs-migration-banner')).toBeTruthy();
    expect(screen.queryByTestId('jobs-migration-convert-all')).toBeNull();
    const panel = await screen.findByTestId('conversion-panel');
    await within(panel).findByTestId('conversion-fidelity-badge');
    expect(screen.queryByTestId('conversion-actions')).toBeNull();
  });

  it('with Flows off there is no column, banner or panel, and New job stays a Job', async () => {
    gate.value = { enabled: false, loaded: true };
    window.location.hash = '#convert-a-1';
    render(<AutomationsPage />);
    await screen.findByText('Nightly cleanup');
    expect(screen.queryByTestId('automation-move-cell-a-1')).toBeNull();
    expect(screen.queryByTestId('jobs-migration-banner')).toBeNull();
    expect(screen.queryByTestId('conversion-panel')).toBeNull();
    expect(screen.getByTestId('automations-new').getAttribute('href')).toBe('/jobs/new');
    expect(conv.listConversions).not.toHaveBeenCalled();
  });

  it('a frozen-row refusal toasts the localized copy, not the token', async () => {
    const toast = await import('../shared/Toast');
    const spy = vi.spyOn(toast, 'showToast');
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' ? json({ error: 'automation_converted', flowId: 'f-1' }, 409) : json({ data: ROWS }));
    render(<AutomationsPage />);
    fireEvent.click(await screen.findByTestId('automation-run-a-1'));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    const message = spy.mock.calls.at(-1)![0].message as string;
    expect(message).toMatch(/moved to Flows/);
    expect(message).not.toContain('automation_converted');
  });
});
