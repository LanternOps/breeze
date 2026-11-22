import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({}),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportEditPage from './ReportEditPage';
import { useOrgStore } from '../../stores/orgStore';

const report = (config: Record<string, unknown>) => ({
  id: 'rep-1',
  name: 'SLA performance',
  type: 'ticket_sla_performance',
  schedule: 'monthly',
  format: 'pdf',
  portalSelfService: false,
  lastGeneratedAt: null,
  orgId: 'org-1',
  partnerId: null,
  config,
});

function mockFetch(config: Record<string, unknown>) {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (init?.method === 'PUT') return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'rep-1' }) });
    if (url === '/reports/rep-1') return Promise.resolve({ ok: true, json: () => Promise.resolve(report(config)) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
  });
}

function putBody() {
  const call = fetchWithAuth.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'PUT');
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

async function save() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /save|update/i }));
  await waitFor(() => expect(putBody()).toBeDefined());
  return putBody();
}

describe('ReportEditPage: ticket_sla_performance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' } as never);
  });

  it('seeds the options form from the stored config', async () => {
    mockFetch({ includeSubjects: true });
    render(<ReportEditPage reportId="rep-1" />);
    const toggle = await screen.findByTestId('sla-performance-include-subjects') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    // The form renders outside the builder; no custom-report sections alongside it.
    expect(screen.queryByTestId('report-builder-columns')).toBeNull();
  });

  it('saves no refused selector, even one a legacy row stored', async () => {
    mockFetch({ dateRange: { preset: 'last_30_days' }, filters: {}, includeSubjects: true });
    render(<ReportEditPage reportId="rep-1" />);
    await screen.findByTestId('sla-performance-include-subjects');
    const body = await save();
    expect(body.config).not.toHaveProperty('dateRange');
    expect(body.config).not.toHaveProperty('filters');
    expect(body.config.includeSubjects).toBe(true);
  });

  it('turning subjects off removes the stored key rather than leaving it to survive the save', async () => {
    mockFetch({ includeSubjects: true });
    render(<ReportEditPage reportId="rep-1" />);
    await userEvent.setup().click(await screen.findByTestId('sla-performance-include-subjects'));
    const body = await save();
    expect(body.config).not.toHaveProperty('includeSubjects');
  });

  it('keeps delivery keys the builder owns', async () => {
    mockFetch({ emailRecipients: ['owner@example.com'] });
    render(<ReportEditPage reportId="rep-1" />);
    await screen.findByTestId('sla-performance-include-subjects');
    const body = await save();
    expect(body.config.emailRecipients).toEqual(['owner@example.com']);
    expect(body.config.schedule).toBeDefined();
  });
});
