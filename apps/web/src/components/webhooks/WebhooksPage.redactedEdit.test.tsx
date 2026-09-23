import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

import WebhooksPage from './WebhooksPage';

// #4983. GET /webhooks never returns the signing secret (only `hasSecret`) and
// returns every custom header value as a redaction marker object. The edit form
// used to pre-fill the secret as '' (so HMAC validation refused to save until
// the operator re-typed a secret they cannot see) and the header value as an
// object (an "[object Object]" input that failed string validation). A webhook
// with credentials saved could no longer be edited.
const redacted = { redacted: true, hasSecret: true, masked: '********' };

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
    headers: [{ key: 'Authorization', value: redacted }],
    status: 'active',
    hasSecret: true,
    ...overrides,
  };
}

async function editAndSave(row: Record<string, unknown>) {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') return json(row);
    if (url.startsWith('/webhooks/wh-1/deliveries')) return json({ data: [] });
    if (url.startsWith('/webhooks')) return json({ data: [row] });
    return json({}, 404);
  });

  render(<WebhooksPage />);
  const [editButton] = await screen.findAllByTitle('Edit webhook');
  fireEvent.click(editButton!);

  const inputs = Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[];
  expect(inputs.map((input) => input.value)).not.toContain('[object Object]');

  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() =>
    expect(fetchWithAuth.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')).toBe(true)
  );
  const [, init] = fetchWithAuth.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')!;
  return JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
}

describe('WebhooksPage — editing a webhook whose secrets come back redacted (#4983)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
  });

  it('saves with the masked secret and masked header value so the API keeps the stored ones', async () => {
    const body = await editAndSave(webhook());
    expect(body.secret).toBe('********');
    expect(body.headers).toEqual([{ key: 'Authorization', value: '********' }]);
  });

  it('keeps plaintext header values as they are', async () => {
    const body = await editAndSave(webhook({ headers: [{ key: 'X-Trace', value: 'abc' }] }));
    expect(body.headers).toEqual([{ key: 'X-Trace', value: 'abc' }]);
  });
});
