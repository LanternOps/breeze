import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
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
});
