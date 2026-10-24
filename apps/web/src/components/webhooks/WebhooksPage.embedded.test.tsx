import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Grant read + manage so every write control (and so every modal) is reachable.
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() };
});
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import WebhooksPage from './WebhooksPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const WEBHOOK = {
  id: 'wh-1',
  orgId: 'org-1',
  name: 'Alert relay',
  url: 'https://hooks.example.com/alerts',
  events: ['alert.created'],
  status: 'active',
  hasSecret: true,
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/deliveries')) return jsonResponse({ data: [] });
    return jsonResponse({ data: [WEBHOOK] });
  });
});

describe('WebhooksPage heading level', () => {
  it('standalone renders the page title as the h1', async () => {
    render(<WebhooksPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Webhooks' })).toBeInTheDocument();
  });

  it('embedded renders the title as an h2 and no h1 (the Integrations page owns the h1)', async () => {
    render(<WebhooksPage embedded />);
    // WebhookList also titles its card "Webhooks" (an h2), so pin the panel
    // header by testid and assert its level.
    const heading = await screen.findByTestId('webhooks-panel-heading');
    expect(heading.tagName).toBe('H2');
    expect(heading).toHaveTextContent('Webhooks');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    // The action stays with the panel header.
    expect(screen.getByRole('button', { name: /new webhook/i })).toBeInTheDocument();
  });
});

describe('WebhooksPage modals are real dialogs (Escape closes)', () => {
  async function expectDialogClosesOnEscape(name: string) {
    const dialog = await screen.findByRole('dialog', { name });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }

  it('create', async () => {
    render(<WebhooksPage />);
    fireEvent.click(await screen.findByRole('button', { name: /new webhook/i }));
    await expectDialogClosesOnEscape('Create Webhook');
  });

  it('edit', async () => {
    render(<WebhooksPage />);
    await screen.findAllByText('Alert relay');
    fireEvent.click(screen.getByTitle('Edit webhook'));
    await expectDialogClosesOnEscape('Edit Webhook');
  });

  it('delete', async () => {
    render(<WebhooksPage />);
    await screen.findAllByText('Alert relay');
    fireEvent.click(screen.getByTitle('Delete webhook'));
    await expectDialogClosesOnEscape('Delete Webhook');
  });
});
