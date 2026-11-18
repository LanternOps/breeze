import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

// #9653. The form had a "Template (JSON)" editor with a live preview, and the
// details card a "Payload template preview", but the API has no template field
// or column: the template was stripped on save and deliveries always used the
// default payload. Until custom templates exist server-side the page must not
// offer one, and must not send a field the API drops.

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

const row = {
  id: 'wh-1',
  orgId: 'org-1',
  name: 'Alert relay',
  url: 'https://hooks.example.com/alerts',
  events: ['alert.triggered'],
  headers: [],
  status: 'active',
  hasSecret: true,
  // A stray template on the row: before the fix the page pre-filled it into
  // the form and echoed it back on save and on test, so the "not sent"
  // assertions below fail if the template plumbing comes back.
  payloadTemplate: '{"text":"{{type}}"}',
};

function mockApi() {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH' || init?.method === 'POST') return json(row);
    if (url.startsWith('/webhooks/wh-1/deliveries')) return json({ data: [] });
    if (url.startsWith('/webhooks')) return json({ data: [row] });
    return json({}, 404);
  });
}

function sentBody(method: string) {
  const call = fetchWithAuth.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === method);
  return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
}

describe('WebhooksPage — payload template is not offered (#9653)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    mockApi();
  });

  it('shows no payload template preview on the details card', async () => {
    render(<WebhooksPage />);
    // Wait for the details card itself, not just the list row.
    await screen.findByText('Authentication');
    expect(screen.queryByText('Payload template preview')).toBeNull();
    expect(screen.queryByText('No payload template saved yet.')).toBeNull();
  });

  it('has no template editor in the form and does not send payloadTemplate on save', async () => {
    render(<WebhooksPage />);
    const [editButton] = await screen.findAllByTitle('Edit webhook');
    fireEvent.click(editButton!);

    expect(document.getElementById('payload-template')).toBeNull();
    expect(screen.queryByText('Template (JSON)')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() =>
      expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true)
    );
    expect(sentBody('PATCH')).not.toHaveProperty('payloadTemplate');
  });

  it('does not send payloadTemplate with a test delivery', async () => {
    render(<WebhooksPage />);
    await screen.findByText('Authentication');
    fireEvent.click(screen.getByText('Test webhook', { selector: 'button' }));
    await waitFor(() =>
      expect(fetchWithAuth.mock.calls.some(([url]) => String(url).endsWith('/test'))).toBe(true)
    );
    expect(sentBody('POST')).not.toHaveProperty('payloadTemplate');
  });
});
