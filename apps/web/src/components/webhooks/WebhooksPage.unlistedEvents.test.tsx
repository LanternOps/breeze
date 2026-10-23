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

// #9693. Events the form has no checkbox for ("*", API-added events) used to be
// dropped on any save from the edit form.
function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

function webhook(events: string[]) {
  return {
    id: 'wh-1', orgId: 'org-1', name: 'Relay', url: 'https://hooks.example.com/a',
    events, headers: [], status: 'active', hasSecret: true,
  };
}

async function openEdit(events: string[]) {
  const row = webhook(events);
  fetchWithAuth.mockImplementation((rawUrl: unknown, init?: RequestInit) => {
    const url = String(rawUrl);
    if (init?.method === 'PATCH') return json(row);
    if (url.startsWith('/webhooks/wh-1/deliveries')) return json({ data: [] });
    if (url.startsWith('/webhooks')) return json({ data: [row] });
    return json({}, 404);
  });
  render(<WebhooksPage />);
  const [editButton] = await screen.findAllByTitle('Edit webhook');
  fireEvent.click(editButton!);
  await screen.findByRole('button', { name: 'Save Changes' });
}

const patched = () =>
  fetchWithAuth.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH');

async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  await waitFor(() => expect(patched()).toBe(true));
  const [, init] = fetchWithAuth.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')!;
  return JSON.parse((init as RequestInit).body as string) as { events: string[] };
}

describe('WebhooksPage edit — events without a checkbox (#9693)', () => {
  beforeEach(() => fetchWithAuth.mockReset());

  it('keeps "*" in the PATCH when only the URL changes, and shows it as a chip', async () => {
    await openEdit(['*']);
    expect(screen.getByText('All events (*)')).toBeTruthy();
    fireEvent.change(document.getElementById('webhook-url')!, { target: { value: 'https://hooks.example.com/b' } });
    const body = await save();
    expect(body.events).toEqual(['*']);
  });

  it('disables the checkbox list while "*" is present', async () => {
    await openEdit(['*']);
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.every((b) => b.closest('fieldset')?.disabled)).toBe(true);
  });

  it('keeps an unlisted event alongside checked ones', async () => {
    await openEdit(['device.online', 'custom.thing']);
    expect(document.querySelector('form')!.textContent).toContain('custom.thing');
    const body = await save();
    expect([...body.events].sort()).toEqual(['custom.thing', 'device.online']);
  });

  it('drops an unlisted event once its chip is removed', async () => {
    await openEdit(['device.online', 'custom.thing']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove custom.thing' }));
    const body = await save();
    expect(body.events).toEqual(['device.online']);
  });

  it('still requires at least one event after the last chip is removed', async () => {
    await openEdit(['custom.thing']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove custom.thing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    await waitFor(() => expect(document.body.textContent).toMatch(/at least one event/i));
    expect(patched()).toBe(false);
  });
});
