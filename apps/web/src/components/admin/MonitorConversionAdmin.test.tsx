import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '../../stores/auth';
import MonitorConversionAdmin from './MonitorConversionAdmin';
it('requires a full preview before confirming and submits its hash', async () => {
  const json = (data: unknown) => new Response(JSON.stringify({ data }));
  const request = vi.mocked(fetchWithAuth);
  request.mockReset();
  request.mockResolvedValueOnce(json([{ partnerId: 'p1', partnerName: 'Acme', pendingRows: 3, pendingPolicies: 1 }]))
    .mockResolvedValueOnce(json({ partnerId: 'p1', previewHash: 'h1', rows: 5, policies: 2, convertible: 4,
      unconvertible: [{ sourceTable: 'alert_templates', sourceId: 's1', name: 'Nested rule', reason: 'unconvertible:nested_group', policyId: null, policyName: null }] }))
    .mockResolvedValueOnce(json({ policies: 2, converted: 4, unconvertible: 1 }))
    .mockResolvedValueOnce(json([]));
  render(<MonitorConversionAdmin />);
  fireEvent.click(await screen.findByTestId('admin-preview-p1'));
  expect(await screen.findByTestId('admin-conversion-confirm')).toHaveTextContent('5 rows across 2 policies');
  expect(screen.getByText(/Nested rule/)).toBeInTheDocument();
  expect(request.mock.calls.some(([url]) => String(url).endsWith('/convert'))).toBe(false);
  fireEvent.click(screen.getByTestId('admin-conversion-run'));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/admin/monitor-conversion/partners/p1/convert', {
    method: 'POST', body: JSON.stringify({ previewHash: 'h1' }),
  }));
});
