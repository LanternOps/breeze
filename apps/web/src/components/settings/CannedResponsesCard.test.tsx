import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));
// pass-through runAction so the request fn (and thus fetchWithAuth) runs
vi.mock('../../lib/runAction', () => ({
  runAction: async (o: { request: () => Promise<Response>; parseSuccess?: (d: unknown) => unknown }) => {
    const r = await o.request();
    const data = await r.json().catch(() => null);
    return o.parseSuccess ? o.parseSuccess(data) : data;
  },
}));

import CannedResponsesCard from './CannedResponsesCard';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

interface Tpl {
  id: string;
  name: string;
  body: string;
  category: string | null;
  sortOrder: number;
  isActive: boolean;
}

function routeFetch(list: Tpl[]) {
  fetchWithAuth.mockImplementation((rawUrl: unknown, opts?: { method?: string }) => {
    const url = String(rawUrl ?? '');
    const method = opts?.method ?? 'GET';
    if (url === '/ticket-response-templates' && method === 'POST') {
      return Promise.resolve(jsonRes({ data: { id: 'new-1', name: 'x', body: 'y', category: null, sortOrder: 0, isActive: true } }, true, 201));
    }
    if (url === '/ticket-response-templates') {
      return Promise.resolve(jsonRes({ data: list }));
    }
    if (url.startsWith('/ticket-response-templates/') && method === 'PATCH') {
      return Promise.resolve(jsonRes({ data: { id: 't-1', name: 'edited', body: 'b', category: null, sortOrder: 0, isActive: true } }));
    }
    if (url.startsWith('/ticket-response-templates/') && method === 'DELETE') {
      return Promise.resolve(jsonRes({ success: true }));
    }
    return Promise.resolve(jsonRes({ data: [] }));
  });
}

beforeEach(() => fetchWithAuth.mockReset());

describe('CannedResponsesCard', () => {
  it('lists existing templates from the API', async () => {
    routeFetch([{ id: 't-1', name: 'Greeting', body: 'Hi {{requester_name}}', category: 'General', sortOrder: 0, isActive: true }]);
    render(<CannedResponsesCard />);
    expect(await screen.findByTestId('canned-responses-card')).toBeTruthy();
    expect(await screen.findByTestId('canned-response-row-t-1')).toBeTruthy();
    expect(screen.getByTestId('canned-response-row-t-1').textContent).toContain('Greeting');
  });

  it('creates a template via POST with name + body + category', async () => {
    routeFetch([]);
    render(<CannedResponsesCard />);
    await screen.findByTestId('canned-responses-card');
    fireEvent.click(screen.getByTestId('canned-response-new'));
    fireEvent.change(screen.getByTestId('canned-response-name'), { target: { value: 'Resolved' } });
    fireEvent.change(screen.getByTestId('canned-response-category'), { target: { value: 'Closing' } });
    fireEvent.change(screen.getByTestId('canned-response-body'), { target: { value: 'Thanks {{requester_name}}' } });
    fireEvent.click(screen.getByTestId('canned-response-save'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/ticket-response-templates', expect.objectContaining({ method: 'POST' })),
    );
    const body = JSON.parse(
      (fetchWithAuth.mock.calls.find((c) => c[0] === '/ticket-response-templates' && (c[1] as { method?: string })?.method === 'POST')![1] as { body: string }).body,
    );
    expect(body.name).toBe('Resolved');
    expect(body.category).toBe('Closing');
    expect(body.body).toBe('Thanks {{requester_name}}');
  });

  it('edits a template via PATCH with the changed fields', async () => {
    routeFetch([{ id: 't-1', name: 'Greeting', body: 'Hi', category: 'General', sortOrder: 0, isActive: true }]);
    render(<CannedResponsesCard />);
    await screen.findByTestId('canned-response-row-t-1');
    fireEvent.click(screen.getByTestId('canned-response-edit-t-1'));
    // form is pre-populated from the row
    expect((screen.getByTestId('canned-response-name') as HTMLInputElement).value).toBe('Greeting');
    fireEvent.change(screen.getByTestId('canned-response-name'), { target: { value: 'Greeting v2' } });
    fireEvent.click(screen.getByTestId('canned-response-save'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/ticket-response-templates/t-1', expect.objectContaining({ method: 'PATCH' })),
    );
    const body = JSON.parse(
      (fetchWithAuth.mock.calls.find(
        (c) => String(c[0]) === '/ticket-response-templates/t-1' && (c[1] as { method?: string })?.method === 'PATCH',
      )![1] as { body: string }).body,
    );
    expect(body.name).toBe('Greeting v2');
  });

  it('deletes a template via DELETE', async () => {
    routeFetch([{ id: 't-1', name: 'Greeting', body: 'Hi', category: null, sortOrder: 0, isActive: true }]);
    render(<CannedResponsesCard />);
    await screen.findByTestId('canned-response-row-t-1');
    fireEvent.click(screen.getByTestId('canned-response-delete-t-1'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/ticket-response-templates/t-1', expect.objectContaining({ method: 'DELETE' })),
    );
  });

  it('offers canned-only merge variables (agent_name) in the insert menu', async () => {
    routeFetch([]);
    render(<CannedResponsesCard />);
    await screen.findByTestId('canned-responses-card');
    fireEvent.click(screen.getByTestId('canned-response-new'));
    expect(screen.getByTestId('canned-response-var-agent_name')).toBeTruthy();
    fireEvent.click(screen.getByTestId('canned-response-var-agent_name'));
    expect((screen.getByTestId('canned-response-body') as HTMLTextAreaElement).value).toContain('{{agent_name}}');
  });
});
