import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import MonitorConversionAdmin from './MonitorConversionAdmin';

const json = (data: unknown) => new Response(JSON.stringify({ data }));
const failure = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
const request = vi.mocked(fetchWithAuth);
const backlog = [{ partnerId: 'p1', partnerName: 'Acme', pendingRows: 3, pendingPolicies: 1 }];
const partnerPreview = { partnerId: 'p1', previewHash: 'h1', rows: 5, policies: 2, convertible: 4,
  unconvertible: [{ sourceTable: 'alert_templates', sourceId: 's1', name: 'Nested rule', reason: 'unconvertible:nested_group', policyId: null, policyName: null }] };
beforeEach(() => { request.mockReset(); vi.mocked(showToast).mockReset(); });

it('requires a full preview before confirming and submits its hash', async () => {
  request.mockResolvedValueOnce(json(backlog))
    .mockResolvedValueOnce(json(partnerPreview))
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

// #6644 review finding 6: the admin page had only the happy path.
it('drops the stale preview on a 409 and shows readable text, not the machine token', async () => {
  request.mockResolvedValueOnce(json(backlog))
    .mockResolvedValueOnce(json(partnerPreview))
    .mockResolvedValueOnce(failure({ error: 'preview_stale', message: 'Preview inputs changed' }, 409));
  render(<MonitorConversionAdmin />);
  fireEvent.click(await screen.findByTestId('admin-preview-p1'));
  fireEvent.click(await screen.findByTestId('admin-conversion-run'));
  await waitFor(() => expect(screen.queryByTestId('admin-conversion-confirm')).toBeNull());
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/preview again/i) }));
  expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'preview_stale' }));
  expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});

it('surfaces MFA_REQUIRED (403) on preview and never opens the confirmation', async () => {
  request.mockResolvedValueOnce(json(backlog))
    .mockResolvedValueOnce(failure({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403));
  render(<MonitorConversionAdmin />);
  fireEvent.click(await screen.findByTestId('admin-preview-p1'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
    type: 'error', message: expect.stringMatching(/multi-factor/i) })));
  expect(screen.queryByTestId('admin-conversion-confirm')).toBeNull();
  expect(request.mock.calls.some(([url]) => String(url).endsWith('/convert'))).toBe(false);
});
