import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import ConversionLedger from './ConversionLedger';
import { showToast } from '../../shared/Toast';
const request = vi.mocked(fetchWithAuth);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const entry = { id: 'c1', sourceTable: 'alert_templates', sourceId: 's1', sourceName: 'Retired template',
  policyId: null, convertedBy: null, convertedAt: '2026-09-19T00:00:00Z', revertedAt: null,
  revertable: true, outputs: [] };
beforeEach(() => vi.resetAllMocks());
it('loads retirement history on a later visit and reverts then refreshes it', async () => {
  request.mockResolvedValueOnce(json({ items: [entry], nextCursor: null }))
    .mockResolvedValueOnce(json({ success: true }))
    .mockResolvedValueOnce(json({ items: [{ ...entry, revertedAt: '2026-09-20', revertable: false }], nextCursor: null }));
  const changed = vi.fn();
  render(<ConversionLedger policyId="p1" onChanged={changed} />);
  fireEvent.click(await screen.findByTestId('ledger-undo-c1'));
  await waitFor(() => expect(request).toHaveBeenCalledWith('/monitor-definitions/conversion/c1/revert', { method: 'POST' }));
  await waitFor(() => expect(changed).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByTestId('ledger-undo-c1')).toBeDisabled());
});
it('paginates and disables Undo when the runtime is retired', async () => {
  request.mockResolvedValueOnce(json({ items: [{ ...entry, revertable: false }], nextCursor: 'next' }))
    .mockResolvedValueOnce(json({ items: [{ ...entry, id: 'c2' }], nextCursor: null }));
  render(<ConversionLedger />);
  expect(await screen.findByTestId('ledger-undo-c1')).toBeDisabled();
  fireEvent.click(screen.getByTestId('ledger-more'));
  expect(await screen.findByTestId('ledger-undo-c2')).toBeEnabled();
  expect(String(request.mock.calls[1]![0])).toContain('cursor=next');
});
it('disables response-only Undo while its target conversion is live', async () => {
  request.mockResolvedValueOnce(json({ items: [{ ...entry, sourceTable: 'automations', revertable: false,
    outputs: [{ monitorId: 'm1', role: 'response', reused: true }] }], nextCursor: null }));
  render(<ConversionLedger />);
  const undo = await screen.findByTestId('ledger-undo-c1');
  expect(undo).toBeDisabled();
  fireEvent.click(undo);
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('formats timestamps, shows converter and monitor names, and labels reverted rows', async () => {
  request.mockResolvedValueOnce(json({ items: [
    { ...entry, convertedBy: 'u1', convertedByName: 'Jamie Lee',
      outputs: [{ monitorId: 'm1', monitorName: 'High CPU', role: 'primary', reused: false }] },
    { ...entry, id: 'c2', revertedAt: '2026-09-20T00:00:00Z', revertable: false },
  ], nextCursor: null }));
  render(<ConversionLedger />);
  await screen.findByTestId('ledger-undo-c1');
  const section = screen.getByTestId('conversion-ledger');
  expect(section.textContent).toContain('Jamie Lee');
  expect(section.textContent).toContain('High CPU');
  expect(section.textContent).not.toContain('2026-09-19T00:00:00Z');
  expect(screen.getByTestId('ledger-reverted-c2')).toHaveTextContent('Reverted');
});
it('refreshes lifecycle state after a 409 and never reports successful Undo', async () => {
  request.mockResolvedValueOnce(json({ items: [entry], nextCursor: null }))
    .mockResolvedValueOnce(json({ error: 'conversion_revert_unavailable' }, 409))
    .mockResolvedValueOnce(json({ items: [{ ...entry, revertable: false }], nextCursor: null }));
  const changed = vi.fn(); render(<ConversionLedger onChanged={changed} />);
  fireEvent.click(await screen.findByTestId('ledger-undo-c1'));
  await waitFor(() => expect(screen.getByTestId('ledger-undo-c1')).toBeDisabled());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
  expect(screen.getByTestId('ledger-undo-c1')).toBeDisabled();
  expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringMatching(/can no longer be undone/i) }));
  expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'conversion_revert_unavailable' }));
  expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  expect(changed).not.toHaveBeenCalled();
});

it.each([
  'config_policy_alert_rules', 'config_policy_monitoring_watches', 'alert_templates',
  'automations', 'config_policy_automations',
])('disables Undo for retired %s', async sourceTable => {
  request.mockResolvedValueOnce(json({ items: [{ ...entry, sourceTable, revertable: false }], nextCursor: null }));
  render(<ConversionLedger />);
  const undo = await screen.findByTestId('ledger-undo-c1');
  expect(undo).toBeDisabled();
  fireEvent.click(undo);
  expect(request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
