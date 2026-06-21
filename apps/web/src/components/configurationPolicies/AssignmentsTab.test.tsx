import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();

vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

import AssignmentsTab from './AssignmentsTab';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const POLICY_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  fetchWithAuth.mockReset();
  // Default: assignments list is empty; any target list returns empty.
  fetchWithAuth.mockResolvedValue(jsonResponse({ data: [] }));
});

describe('AssignmentsTab — Partner-Wide (All Orgs)', () => {
  it('never calls /orgs/partners when the Partner-Wide level is selected (#1724)', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={ORG_ID} />);

    // Initial load fetches the assignments list + the default (organization)
    // target options. Wait for that to settle.
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    // Switch the Level select to Partner-Wide.
    const levelSelect = screen.getByDisplayValue('Organization');
    fireEvent.change(levelSelect, { target: { value: 'partner' } });

    await waitFor(() =>
      expect(screen.getByText('All organizations in your partner')).toBeInTheDocument()
    );

    // The old system-scoped partner-list call must NEVER be made.
    const urls = fetchWithAuth.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/orgs/partners'))).toBe(false);
  });

  it('POSTs a partner assignment with no targetId (server-derived) (#1724)', async () => {
    render(<AssignmentsTab policyId={POLICY_ID} orgId={ORG_ID} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    fireEvent.change(screen.getByDisplayValue('Organization'), { target: { value: 'partner' } });
    await waitFor(() =>
      expect(screen.getByText('All organizations in your partner')).toBeInTheDocument()
    );

    // The create POST returns a created assignment; the follow-up list refetch
    // returns empty.
    fetchWithAuth.mockResolvedValueOnce(jsonResponse({ id: 'a1', level: 'partner' }, 201));

    fireEvent.click(screen.getByRole('button', { name: /Assign/i }));

    await waitFor(() => {
      const post = fetchWithAuth.mock.calls.find(
        (c) => String(c[0]).endsWith(`/configuration-policies/${POLICY_ID}/assignments`) &&
          (c[1] as RequestInit | undefined)?.method === 'POST'
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(String((post![1] as RequestInit).body));
      expect(body.level).toBe('partner');
      expect(body).not.toHaveProperty('targetId');
    });
  });
});
