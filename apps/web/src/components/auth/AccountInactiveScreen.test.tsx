import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  apiLogout: vi.fn(),
  fetchWithAuth: vi.fn(),
}));

import AccountInactiveScreen from './AccountInactiveScreen';
import { apiLogout, fetchWithAuth } from '../../stores/auth';

describe('AccountInactiveScreen sign out', () => {
  const originalLocation = window.location;
  let assignedHref = '';

  beforeEach(() => {
    vi.clearAllMocks();
    assignedHref = '';
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        origin: originalLocation.origin,
        set href(value: string) { assignedHref = value; },
        get href() { return assignedHref; },
      },
    });
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({
      status: 'suspended',
      statusMessage: 'Suspended',
      statusActionUrl: null,
      statusActionLabel: null,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it.each([
    ['server success', () => Promise.resolve()],
    ['network failure', () => Promise.reject(new Error('offline'))],
  ])('attempts server logout and navigates in finally on %s', async (_label, makeLogoutResult) => {
    vi.mocked(apiLogout).mockImplementationOnce(makeLogoutResult);
    render(<AccountInactiveScreen />);
    fireEvent.click(await screen.findByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(apiLogout).toHaveBeenCalledOnce());
    await waitFor(() => expect(assignedHref).toBe('/login'));
  });
});
