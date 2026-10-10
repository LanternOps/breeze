import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
// This suite drives webhook writes, so the caller can read webhooks and manage
// them (organizations:write). Read-only behaviour is covered in
// WebhooksPage.permissions.test.tsx.
const GRANTED = vi.hoisted(() => new Set(['webhooks:read', 'organizations:write']));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => GRANTED.has(`${r}:${a}`) }),
}));
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import { showToast } from '../shared/Toast';
import WebhooksPage from './WebhooksPage';

// #6767. PATCH /webhooks/:id speaks `status: 'active' | 'paused' | 'failed'`.
// The list toggle sent `{ enabled }`, which the API's zod schema strips, then
// flipped the row locally — it looked toggled until the next reload. The page
// also read a paused webhook (API status 'paused') as enabled.

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function webhook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wh-1',
    orgId: 'org-1',
    name: 'Alert relay',
    url: 'https://hooks.example.com/alerts',
    events: ['alert.created'],
    headers: [],
    status: 'active',
    hasSecret: true,
    ...overrides,
  };
}

function serve(row: Record<string, unknown>, patch: (body: Record<string, unknown>) => Promise<Response>) {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return patch(JSON.parse(init.body as string));
    if (url.startsWith('/webhooks/wh-1/deliveries')) return json({ data: [] });
    if (url.startsWith('/webhooks')) return json({ data: [row] });
    return json({}, 404);
  });
}

function patchBodies() {
  return fetchWithAuth.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);
}

describe('WebhooksPage — enable/disable (#6767)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    vi.mocked(showToast).mockReset();
  });

  it('pauses an active webhook with PATCH { status: "paused" } and shows the saved state', async () => {
    serve(webhook(), (body) => json(webhook({ status: body.status })));
    render(<WebhooksPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Active' }));

    await waitFor(() => expect(patchBodies()).toEqual([{ status: 'paused' }]));
    expect(await screen.findByRole('button', { name: 'Disabled' })).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Webhook disabled' }));
  });

  it('shows a paused webhook as disabled and resumes it with { status: "active" }', async () => {
    serve(webhook({ status: 'paused' }), (body) => json(webhook({ status: body.status })));
    render(<WebhooksPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disabled' }));

    await waitFor(() => expect(patchBodies()).toEqual([{ status: 'active' }]));
    expect(await screen.findByRole('button', { name: 'Active' })).toBeTruthy();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Webhook enabled' }));
  });

  it('toasts a rejected toggle and leaves the row as it was', async () => {
    serve(webhook(), () => json({ error: 'Webhook changed concurrently; reload and retry' }, 409));
    render(<WebhooksPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Active' }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
        type: 'error',
        message: 'Webhook changed concurrently; reload and retry',
      }))
    );
    expect(screen.getByRole('button', { name: 'Active' })).toBeTruthy();
  });

  it('edit form opens a paused webhook as disabled and saves without re-activating it', async () => {
    serve(webhook({ status: 'paused' }), (body) => json(webhook({ status: 'paused', ...body })));
    render(<WebhooksPage />);

    const [editButton] = await screen.findAllByTitle('Edit webhook');
    fireEvent.click(editButton!);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    const [body] = patchBodies();
    expect(body).not.toHaveProperty('enabled');
    expect(body!.status).not.toBe('active');
  });

  it('edit form enabled switch is sent as status', async () => {
    serve(webhook(), (body) => json(webhook({ ...body })));
    render(<WebhooksPage />);

    const [editButton] = await screen.findAllByTitle('Edit webhook');
    fireEvent.click(editButton!);
    fireEvent.click(screen.getByRole('button', { name: 'Enabled' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(patchBodies()).toHaveLength(1));
    expect(patchBodies()[0]!.status).toBe('paused');
  });

  it('shows a success toast when saving edits (sweep A1)', async () => {
    serve(webhook(), (body) => json(webhook({ ...body })));
    render(<WebhooksPage />);

    const [editButton] = await screen.findAllByTitle('Edit webhook');
    fireEvent.click(editButton!);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Webhook updated' }))
    );
  });
});

describe('WebhooksPage — delivery retry', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    vi.mocked(showToast).mockReset();
  });

  it('POSTs the real API route /webhooks/:id/retry/:deliveryId, toasts, and refetches deliveries', async () => {
    const failed = { id: 'del-9', eventType: 'alert.created', status: 'failed', createdAt: '2026-10-01T00:00:00Z' };
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return url === '/webhooks/wh-1/retry/del-9'
          ? json({ message: 'Delivery retry queued', delivery: { id: 'del-10', status: 'pending' } }, 202)
          : json({ error: 'Not Found' }, 404);
      }
      if (url.startsWith('/webhooks/wh-1/deliveries')) return json({ data: [failed] });
      if (url.startsWith('/webhooks')) return json({ data: [webhook()] });
      return json({}, 404);
    });
    render(<WebhooksPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^retry$/i }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Delivery retry queued' }))
    );
    const deliveryFetches = fetchWithAuth.mock.calls.filter(([u]) => String(u).startsWith('/webhooks/wh-1/deliveries'));
    expect(deliveryFetches.length).toBeGreaterThanOrEqual(2);
  });
});
