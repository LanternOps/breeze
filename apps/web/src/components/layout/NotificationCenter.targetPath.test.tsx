import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() })
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import NotificationCenter from './NotificationCenter';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigateTo);

const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
  navigateMock.mockReset();
});

describe('NotificationCenter automation target path (#5288)', () => {
  it('routes an automation notification to /jobs, not /automations', async () => {
    fetchMock.mockResolvedValue(
      json({
        notifications: [
          {
            id: 'n1',
            type: 'automation',
            title: 'Nightly cleanup failed',
            message: 'Run failed',
            createdAt: '2026-09-10T00:00:00.000Z',
            read: true
          }
        ]
      })
    );

    render(<NotificationCenter />);

    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: /notifications/i });
    await user.click(trigger);

    const row = await screen.findByText('Nightly cleanup failed');
    await user.click(row);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/jobs'));
  });
});

describe('NotificationCenter deep links (#4461)', () => {
  it('routes an approval notification with an intentId to the approvals hash', async () => {
    fetchMock.mockResolvedValue(
      json({
        notifications: [
          {
            id: 'n2',
            type: 'approval',
            title: 'Approval requested',
            message: 'Something needs approval',
            createdAt: '2026-09-10T00:00:00.000Z',
            read: true,
            metadata: { intentId: 'intent-abc' }
          }
        ]
      })
    );

    render(<NotificationCenter />);

    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: /notifications/i });
    await user.click(trigger);

    const row = await screen.findByText('Approval requested');
    await user.click(row);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/approvals#intent-intent-abc'));
  });

  it('routes an ai notification with a runId to the run detail page, not /ai-risk', async () => {
    fetchMock.mockResolvedValue(
      json({
        notifications: [
          {
            id: 'n3',
            type: 'ai',
            title: 'Agent circuit breaker opened',
            message: 'Paused',
            createdAt: '2026-09-10T00:00:00.000Z',
            read: true,
            metadata: { runId: 'run-123' }
          }
        ]
      })
    );

    render(<NotificationCenter />);

    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: /notifications/i });
    await user.click(trigger);

    const row = await screen.findByText('Agent circuit breaker opened');
    await user.click(row);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/ai-agents/runs/run-123'));
  });

  it('does not fall back to /ai-risk for an ai notification with no usable id', async () => {
    fetchMock.mockResolvedValue(
      json({
        notifications: [
          {
            id: 'n4',
            type: 'ai',
            title: 'AI notice',
            message: 'No ids here',
            createdAt: '2026-09-10T00:00:00.000Z',
            read: true
          }
        ]
      })
    );

    render(<NotificationCenter />);

    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: /notifications/i });
    await user.click(trigger);

    const row = await screen.findByText('AI notice');
    await user.click(row);

    await waitFor(() => expect(navigateMock).not.toHaveBeenCalledWith('/ai-risk'));
  });

  it('routes an alert notification to metadata.alertId when there is no top-level alertId column', async () => {
    fetchMock.mockResolvedValue(
      json({
        notifications: [
          {
            id: 'n5',
            type: 'alert',
            title: 'Disk space critical',
            message: 'C: drive at 98%',
            createdAt: '2026-09-10T00:00:00.000Z',
            read: true,
            metadata: { alertId: 'alert-xyz' }
          }
        ]
      })
    );

    render(<NotificationCenter />);

    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: /notifications/i });
    await user.click(trigger);

    const row = await screen.findByText('Disk space critical');
    await user.click(row);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/alerts/alert-xyz'));
  });

  it('does not throw on a malformed (non-object) metadata field', async () => {
    fetchMock.mockResolvedValue(
      json({
        notifications: [
          {
            id: 'n6',
            type: 'approval',
            title: 'Approval requested',
            message: 'Something needs approval',
            createdAt: '2026-09-10T00:00:00.000Z',
            read: true,
            metadata: 'not-an-object'
          }
        ]
      })
    );

    render(<NotificationCenter />);

    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: /notifications/i });
    await user.click(trigger);

    const row = await screen.findByText('Approval requested');
    await user.click(row);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/approvals'));
  });

  it('does not render a literal "undefined" agent hash when metadata.agentId is not a string', async () => {
    fetchMock.mockResolvedValue(
      json({
        notifications: [
          {
            id: 'n7',
            type: 'ai',
            title: 'Agent circuit breaker opened',
            message: 'Paused',
            createdAt: '2026-09-10T00:00:00.000Z',
            read: true,
            metadata: { agentId: 12345 }
          }
        ]
      })
    );

    render(<NotificationCenter />);

    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: /notifications/i });
    await user.click(trigger);

    const row = await screen.findByText('Agent circuit breaker opened');
    await user.click(row);

    await waitFor(() => expect(navigateMock).not.toHaveBeenCalledWith(expect.stringContaining('undefined')));
  });
});
