import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import AutopayListPage from './AutopayListPage';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchWithAuth).mockImplementation(async (_url, init) => Response.json(init?.method === 'POST'
    ? { requested: [], skipped: [{ orgId: id, reason: 'no_billing_contact' }] }
    : { data: [{ orgId: id, orgName: 'Example client', billingContact: null, status: 'not_requested', enrollment: null, method: null }], notRequestedCount: 1 }));
});
it('does not label partial bulk failure as success and retains per-org reason', async () => {
  render(<AutopayListPage />);
  fireEvent.click(await screen.findByTestId('autopay-send-now'));
  expect(await screen.findByTestId('autopay-bulk-result')).toHaveTextContent('no_billing_contact');
  expect(vi.mocked(showToast).mock.calls.some(([toast]) => toast.type === 'success')).toBe(false);
  const call = vi.mocked(fetchWithAuth).mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(JSON.parse(call[1]!.body as string)).toEqual({ orgIds: [id] });
});
it('dismisses only the local prompt and never sends a request', async () => {
  render(<AutopayListPage />);
  fireEvent.click(await screen.findByTestId('autopay-dismiss'));
  expect(screen.queryByTestId('autopay-unasked')).toBeNull();
  expect(vi.mocked(fetchWithAuth).mock.calls.every(([, i]) => !i?.method)).toBe(true);
});
