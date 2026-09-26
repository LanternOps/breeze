import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import NetworkCheckConversionBanner from './NetworkCheckConversionBanner';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const request = vi.mocked(fetchWithAuth);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const item = { sourceTable: 'network_monitors', sourceId: 'check-1', name: 'Gateway', outcome: 'convertible', notes: ['Preserves history'], openAlerts: 0 };
const preview = (items = [item]) => ({ orgId: 'org-1', previewHash: 'a'.repeat(64), items });
beforeEach(() => vi.resetAllMocks());

it('reviews both outcomes and converts only representable checks', async () => {
  request.mockImplementation(async (url, init) => {
    if (init?.method) return json({ monitorsCreated: 1 });
    if (String(url).includes('/ledger?')) return json({ items: [], nextCursor: null });
    return json(preview([item, { ...item, sourceId: 'check-2', name: 'Unsupported', outcome: 'unconvertible', notes: [], reason: 'unconvertible:network_predicate_unsupported' } as typeof item]));
  });
  const changed = vi.fn();
  render(<NetworkCheckConversionBanner orgId="org-1" onConverted={changed} />);
  expect(await screen.findByTestId('network-check-conversion-banner')).toHaveTextContent('2 network checks');
  fireEvent.click(screen.getByTestId('network-check-conversion-review'));
  expect(screen.getByText('Preserves history')).toBeInTheDocument();
  expect(screen.getByText('unconvertible:network_predicate_unsupported')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('network-check-conversion-confirm'));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/monitor-definitions/conversion/network-checks/convert', {
    method: 'POST', body: JSON.stringify({ orgId: 'org-1', previewHash: 'a'.repeat(64), sourceIds: ['check-1'] }),
  }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
});

it.each(['convertible', 'unconvertible'])('retires a %s check, retains empty history, and undoes it', async outcome => {
  let retired = false;
  let undone = false;
  request.mockImplementation(async (url, init) => {
    if (url === '/monitor-definitions/conversion/retire') { retired = true; return json({ conversionId: 'c1' }); }
    if (url === '/monitor-definitions/conversion/c1/revert') { retired = false; undone = true; return json({ success: true }); }
    if (String(url).includes('/ledger?')) return json({ nextCursor: null, items: retired || undone ? [{ id: 'c1', sourceTable: 'network_monitors', sourceId: 'check-1', sourceName: 'Gateway', policyId: null, convertedBy: null, convertedAt: '2026-09-19T00:00:00Z', revertedAt: undone ? '2026-09-20T00:00:00Z' : null, revertable: !undone, outputs: [] }] : [] });
    if (String(url).includes('/network-checks?')) return json(preview(retired ? [] : [{ ...item, outcome }]));
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
  const changed = vi.fn();
  render(<NetworkCheckConversionBanner orgId="org-1" onConverted={changed} />);
  fireEvent.click(await screen.findByTestId('network-check-conversion-review'));
  if (outcome === 'unconvertible') expect(screen.getByTestId('network-check-conversion-confirm')).toBeDisabled();
  fireEvent.click(screen.getByTestId('network-check-retire-check-1'));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/monitor-definitions/conversion/retire', { method: 'POST', body: JSON.stringify({ sourceTable: 'network_monitors', sourceId: 'check-1', reason: 'operator' }) }));
  await waitFor(() => expect(screen.queryByTestId('network-check-conversion-banner')).not.toBeInTheDocument());
  expect(changed).toHaveBeenCalledTimes(1);
  expect(await screen.findByTestId('ledger-undo-c1')).toBeEnabled();
  expect(screen.getByTestId('conversion-ledger')).toHaveTextContent('Gateway');
  fireEvent.click(screen.getByTestId('ledger-undo-c1'));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  expect(await screen.findByTestId('network-check-conversion-review')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId('ledger-undo-c1')).toBeDisabled());
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});

it('shows blocked-empty prerequisites without mutations', async () => {
  request.mockImplementation(async url => json(String(url).includes('/ledger?') ? { items: [], nextCursor: null } : { ...preview([]), blockedBy: 'prerequisite_missing' }));
  render(<NetworkCheckConversionBanner orgId="org-1" onConverted={vi.fn()} />);
  expect(await screen.findByTestId('network-check-conversion-blocked')).toHaveTextContent(/prerequisite/i);
  expect(screen.queryByTestId('network-check-conversion-review')).not.toBeInTheDocument();
  expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it.each(['conflict', 'network'])('keeps review and retry available after retirement %s failure', async failure => {
  request.mockImplementation(async (url, init) => {
    if (init?.method) {
      if (failure === 'network') throw new Error('offline');
      return json({ error: 'already_converted' }, 409);
    }
    return json(String(url).includes('/ledger?') ? { items: [], nextCursor: null } : preview());
  });
  const changed = vi.fn();
  render(<NetworkCheckConversionBanner orgId="org-1" onConverted={changed} />);
  fireEvent.click(await screen.findByTestId('network-check-conversion-review'));
  fireEvent.click(screen.getByTestId('network-check-retire-check-1'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  await waitFor(() => expect(screen.getByTestId('network-check-retire-check-1')).toBeEnabled());
  expect(changed).not.toHaveBeenCalled();
  expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});

it('reports a failed preview and supports retry', async () => {
  let failing = true;
  request.mockImplementation(async url => {
    if (String(url).includes('/ledger?')) return json({ items: [], nextCursor: null });
    if (failing) throw new Error('offline');
    return json(preview());
  });
  render(<NetworkCheckConversionBanner orgId="org-1" onConverted={vi.fn()} />);
  expect(await screen.findByTestId('network-check-conversion-error')).toBeInTheDocument();
  failing = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('network-check-conversion-review')).toBeInTheDocument();
});
