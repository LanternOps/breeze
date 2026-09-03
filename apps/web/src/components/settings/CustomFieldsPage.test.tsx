import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

const fetchWithAuth = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
      selector({ user: {} }),
    { getState: () => ({ tokens: null }) },
  ),
}));

import CustomFieldsPage from './CustomFieldsPage';

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('CustomFieldsPage — field key help (issue #4198)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValue(json([]));
  });

  it('shows a help affordance next to Field Key explaining how scripts read/write it', async () => {
    render(<CustomFieldsPage />);

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Add your first custom field' }));

    const trigger = await screen.findByRole('button', { name: 'About using this field in scripts' });
    fireEvent.click(trigger);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/PATCH request/i);
  });
});
