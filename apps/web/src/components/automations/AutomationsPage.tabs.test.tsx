import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: vi.fn() };
});
import AutomationsPage, { JOB_TABS, triggerFilterForTab } from './AutomationsPage';
import { fetchWithAuth } from '../../stores/auth';

const rows = [
  { id: '1', name: 'Nightly cleanup', enabled: true, triggerType: 'schedule', trigger: { type: 'schedule', cron: '0 2 * * *' }, actions: [], runCount: 0 },
  { id: '2', name: 'Inbound webhook', enabled: true, triggerType: 'webhook', trigger: { type: 'webhook' }, actions: [], runCount: 0 },
  { id: '3', name: 'On disk alert', enabled: true, triggerType: 'event', trigger: { type: 'event', event: 'alert.triggered' }, actions: [], runCount: 0 },
];

describe('Jobs tabs (#5288)', () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({ data: rows }), { status: 200 }));
  });

  it('maps every tab to a trigger filter', () => {
    expect(JOB_TABS).toEqual(['all', 'scheduled', 'on-demand', 'webhooks', 'event-rules']);
    expect(triggerFilterForTab('scheduled')).toBe('schedule');
    expect(triggerFilterForTab('on-demand')).toBe('manual');
    expect(triggerFilterForTab('webhooks')).toBe('webhook');
    expect(triggerFilterForTab('event-rules')).toBe('event');
    expect(triggerFilterForTab('all')).toBe('all');
  });

  it('#webhooks shows only webhook jobs', async () => {
    window.location.hash = '#webhooks';
    render(<AutomationsPage />);
    await waitFor(() => expect(screen.getByText('Inbound webhook')).toBeInTheDocument());
    expect(screen.queryByText('Nightly cleanup')).toBeNull();
    expect(screen.queryByText('On disk alert')).toBeNull();
    window.location.hash = '';
  });

  it('clicking the "Event rules" tab filters the list and writes the hash (PR #5648 review)', async () => {
    render(<AutomationsPage />);
    await waitFor(() => expect(screen.getByText('Nightly cleanup')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Event rules' }));

    await waitFor(() => expect(screen.getByText('On disk alert')).toBeInTheDocument());
    expect(screen.queryByText('Nightly cleanup')).toBeNull();
    expect(screen.queryByText('Inbound webhook')).toBeNull();
    expect(window.location.hash).toBe('#event-rules');
    expect(screen.getByRole('button', { name: 'Event rules' })).toHaveAttribute('aria-current', 'page');

    window.location.hash = '';
  });

  it("changing AutomationList's own trigger select switches tabs (reverse mapping, PR #5648 review)", async () => {
    render(<AutomationsPage />);
    await waitFor(() => expect(screen.getByText('Nightly cleanup')).toBeInTheDocument());

    fireEvent.change(screen.getByDisplayValue('All Triggers'), { target: { value: 'webhook' } });

    await waitFor(() => expect(screen.getByText('Inbound webhook')).toBeInTheDocument());
    expect(screen.queryByText('Nightly cleanup')).toBeNull();
    expect(window.location.hash).toBe('#webhooks');
    expect(screen.getByRole('button', { name: 'Webhooks' })).toHaveAttribute('aria-current', 'page');

    window.location.hash = '';
  });
});
