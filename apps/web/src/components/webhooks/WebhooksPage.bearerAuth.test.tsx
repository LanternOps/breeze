import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
const GRANTED = vi.hoisted(() => new Set(['webhooks:read', 'organizations:write']));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => GRANTED.has(`${r}:${a}`) }),
}));
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

import WebhooksPage from './WebhooksPage';

// #9652. Bearer authentication is stored by the API as an encrypted
// `Authorization: Bearer <token>` custom header. The form's Bearer option must
// write that header (not the `auth`/`bearerToken` fields the API never had),
// and read it back from GET (`authType: 'bearer'` plus a redacted header).
const redacted = { redacted: true, hasSecret: true, masked: '********' };

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function webhook(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wh-1',
    orgId: 'org-1',
    name: 'Ticket relay',
    url: 'https://hooks.example.com/in',
    events: ['device.online'],
    headers: [],
    status: 'active',
    hasSecret: true,
    authType: 'hmac',
    ...overrides,
  };
}

const bearerWebhook = () => webhook({
  hasSecret: false,
  authType: 'bearer',
  headers: [
    { key: 'X-Trace', value: 'abc' },
    { key: 'Authorization', value: redacted },
  ],
});

function serve(rows: Record<string, unknown>[]) {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH' || init?.method === 'POST') return json(rows[0] ?? webhook(), init.method === 'POST' ? 201 : 200);
    if (url.includes('/deliveries')) return json({ data: [] });
    if (url.startsWith('/webhooks')) return json({ data: rows });
    return json({}, 404);
  });
}

async function sentBody(method: 'POST' | 'PATCH') {
  await waitFor(() =>
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === method)).toBe(true)
  );
  const [, init] = fetchWithAuth.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === method)!;
  return JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
}

async function openEdit(row: Record<string, unknown>) {
  serve([row]);
  render(<WebhooksPage />);
  const [editButton] = await screen.findAllByTitle('Edit webhook');
  fireEvent.click(editButton!);
}

const tokenInput = () => document.getElementById('webhook-token') as HTMLInputElement | null;
const secretInput = () => document.getElementById('webhook-secret') as HTMLInputElement | null;
const headerKeyValues = () =>
  (Array.from(document.querySelectorAll('input[placeholder]')) as HTMLInputElement[])
    .map((input) => input.value);

describe('WebhooksPage — bearer token authentication (#9652)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
  });

  it('creates a bearer webhook as an Authorization header with no signing secret', async () => {
    serve([]);
    render(<WebhooksPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New Webhook' }));

    fireEvent.change(document.getElementById('webhook-name')!, { target: { value: 'Bearer hook' } });
    fireEvent.change(document.getElementById('webhook-url')!, { target: { value: 'https://hooks.example.com/in' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Device Online/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Bearer token/ }));
    fireEvent.change(tokenInput()!, { target: { value: 'tok-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Webhook' }));

    const body = await sentBody('POST');
    expect(body.headers).toEqual([{ key: 'Authorization', value: 'Bearer tok-123' }]);
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('auth');
    expect(body).not.toHaveProperty('bearerToken');
  });

  it('does not double the scheme when the token is pasted with "Bearer " in front', async () => {
    serve([]);
    render(<WebhooksPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New Webhook' }));

    fireEvent.change(document.getElementById('webhook-name')!, { target: { value: 'Bearer hook' } });
    fireEvent.change(document.getElementById('webhook-url')!, { target: { value: 'https://hooks.example.com/in' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Device Online/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Bearer token/ }));
    fireEvent.change(tokenInput()!, { target: { value: 'Bearer tok-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Webhook' }));

    const body = await sentBody('POST');
    expect(body.headers).toEqual([{ key: 'Authorization', value: 'Bearer tok-123' }]);
  });

  it('opens a bearer webhook with Bearer selected and the token masked, not as a custom header', async () => {
    await openEdit(bearerWebhook());

    expect(screen.getByRole('radio', { name: /Bearer token/ })).toBeChecked();
    expect(tokenInput()?.value).toBe('********');
    expect(headerKeyValues()).toContain('X-Trace');
    expect(headerKeyValues()).not.toContain('Authorization');
  });

  it('re-saves an untouched bearer webhook so the API keeps the stored token', async () => {
    await openEdit(bearerWebhook());
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    const body = await sentBody('PATCH');
    expect(body.headers).toEqual([
      { key: 'X-Trace', value: 'abc' },
      { key: 'Authorization', value: '********' },
    ]);
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('auth');
    expect(body).not.toHaveProperty('bearerToken');
  });

  it('switches an HMAC webhook to bearer: sends the header and clears the secret', async () => {
    await openEdit(webhook());
    fireEvent.click(screen.getByRole('radio', { name: /Bearer token/ }));
    fireEvent.change(tokenInput()!, { target: { value: 'tok-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    const body = await sentBody('PATCH');
    expect(body.secret).toBeNull();
    expect(body.headers).toEqual([{ key: 'Authorization', value: 'Bearer tok-new' }]);
  });

  it('switches a bearer webhook to HMAC: drops the Authorization header and sends the secret', async () => {
    await openEdit(bearerWebhook());
    fireEvent.click(screen.getByRole('radio', { name: /HMAC signature/ }));
    fireEvent.change(secretInput()!, { target: { value: 'new-signing-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    const body = await sentBody('PATCH');
    expect(body.secret).toBe('new-signing-secret');
    expect(body.headers).toEqual([{ key: 'X-Trace', value: 'abc' }]);
  });

  it('shows Bearer token on the details card for a bearer webhook', async () => {
    serve([bearerWebhook()]);
    render(<WebhooksPage />);
    const label = await screen.findByText('Authentication');
    const card = label.parentElement as HTMLElement;
    expect(within(card).getByText('Bearer token')).toBeInTheDocument();
    expect(within(card).queryByText('HMAC signature')).not.toBeInTheDocument();
  });
});
