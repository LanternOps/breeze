import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import RecommendedMonitors from './RecommendedMonitors';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

const monitor = {
  id: '33333333-3333-4333-8333-333333333333',
  builtinKey: 'shipped-key',
  orgId: null,
  partnerId: '22222222-2222-4222-8222-222222222222',
  attachmentCount: 0,
};
const existingMonitorId = '44444444-4444-4444-8444-444444444444';
const policyId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => vi.resetAllMocks());

it('attaches built-ins to a chosen policy without discarding replacement mode', async () => {
  fetchMock
    .mockResolvedValueOnce(json({ data: [{ id: policyId, name: 'Servers' }], pagination: { total: 1 } }))
    .mockResolvedValueOnce(
      json({ data: [{ id: 'link', featureType: 'monitors', inlineSettings: { items: [], inheritance: 'replace' } }] }),
    )
    .mockResolvedValueOnce(json({ data: { id: 'link' } }));
  const onAttached = vi.fn();
  render(<RecommendedMonitors rows={[monitor]} onAttached={onAttached} />);
  fireEvent.click(screen.getByTestId('recommended-open'));
  await screen.findByText('Servers');
  fireEvent.change(screen.getByTestId('recommended-policy'), { target: { value: policyId } });
  fireEvent.click(screen.getByTestId('recommended-attach'));
  await waitFor(() => expect(onAttached).toHaveBeenCalled());
  const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
  expect(write[0]).toBe(`/configuration-policies/${policyId}/features/link`);
  expect(JSON.parse(String(write[1]!.body)).inlineSettings).toEqual({
    inheritance: 'replace',
    items: [{ monitorId: monitor.id, enabled: true, sortOrder: 0 }],
  });
});

it('keeps existing attachments and creates the monitors link when the policy has none', async () => {
  fetchMock
    .mockResolvedValueOnce(json({ data: [{ id: policyId, name: 'Servers' }], pagination: { total: 1 } }))
    .mockResolvedValueOnce(json({ data: [{ id: 'other', featureType: 'patch', inlineSettings: {} }] }))
    .mockResolvedValueOnce(json({ data: { id: 'new-link' } }, 201));
  render(<RecommendedMonitors rows={[monitor]} onAttached={vi.fn()} />);
  fireEvent.click(screen.getByTestId('recommended-open'));
  await screen.findByText('Servers');
  fireEvent.change(screen.getByTestId('recommended-policy'), { target: { value: policyId } });
  fireEvent.click(screen.getByTestId('recommended-attach'));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(write[0]).toBe(`/configuration-policies/${policyId}/features`);
  expect(JSON.parse(String(write[1]!.body))).toMatchObject({
    featureType: 'monitors',
    inlineSettings: { inheritance: 'cumulative', items: [{ monitorId: monitor.id, enabled: true, sortOrder: 0 }] },
  });
});

it('preserves existing items (and does not duplicate an already-attached recommendation)', async () => {
  const existing = { monitorId: existingMonitorId, enabled: false, overrides: { threshold: 5 }, sortOrder: 0 };
  fetchMock
    .mockResolvedValueOnce(json({ data: [{ id: policyId, name: 'Servers' }], pagination: { total: 1 } }))
    .mockResolvedValueOnce(
      json({
        data: [
          {
            id: 'link',
            featureType: 'monitors',
            inlineSettings: { items: [existing], inheritance: 'cumulative' },
          },
        ],
      }),
    )
    .mockResolvedValueOnce(json({ data: { id: 'link' } }));
  render(<RecommendedMonitors rows={[monitor]} onAttached={vi.fn()} />);
  fireEvent.click(screen.getByTestId('recommended-open'));
  await screen.findByText('Servers');
  fireEvent.change(screen.getByTestId('recommended-policy'), { target: { value: policyId } });
  fireEvent.click(screen.getByTestId('recommended-attach'));
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true));
  const write = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
  expect(JSON.parse(String(write[1]!.body)).inlineSettings.items).toEqual([
    existing,
    { monitorId: monitor.id, enabled: true, sortOrder: 1 },
  ]);
});

it('hides deployed or unknown-count built-ins and never uses ordinary definitions', () => {
  const { container } = render(
    <RecommendedMonitors
      rows={[
        { ...monitor, attachmentCount: 1 },
        { ...monitor, attachmentCount: undefined },
        { ...monitor, builtinKey: null },
      ]}
      onAttached={vi.fn()}
    />,
  );
  expect(container).toBeEmptyDOMElement();
});

it('keeps attachment disabled on a failed policy read', async () => {
  fetchMock.mockResolvedValue(json({ error: 'unavailable' }, 500));
  render(<RecommendedMonitors rows={[monitor]} onAttached={vi.fn()} />);
  fireEvent.click(screen.getByTestId('recommended-open'));
  expect(await screen.findByTestId('recommended-retry')).toBeInTheDocument();
  expect(screen.getByTestId('recommended-attach')).toBeDisabled();
});

it('refuses a monitors link backed by a shared feature policy before any write, with a specific message', async () => {
  fetchMock
    .mockResolvedValueOnce(json({ data: [{ id: policyId, name: 'Servers' }], pagination: { total: 1 } }))
    .mockResolvedValueOnce(
      json({ data: [{ id: 'link', featureType: 'monitors', featurePolicyId: 'shared-1', inlineSettings: null }] }),
    );
  const onAttached = vi.fn();
  render(<RecommendedMonitors rows={[monitor]} onAttached={onAttached} />);
  fireEvent.click(screen.getByTestId('recommended-open'));
  await screen.findByText('Servers');
  fireEvent.change(screen.getByTestId('recommended-policy'), { target: { value: policyId } });
  fireEvent.click(screen.getByTestId('recommended-attach'));
  await waitFor(() =>
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('shared feature policy') }),
    ),
  );
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH' || init?.method === 'POST')).toBe(false);
  expect(onAttached).not.toHaveBeenCalled();
});

it('surfaces a refused attach without calling onAttached', async () => {
  fetchMock
    .mockResolvedValueOnce(json({ data: [{ id: policyId, name: 'Servers' }], pagination: { total: 1 } }))
    .mockResolvedValueOnce(json({ data: [] }))
    .mockResolvedValueOnce(json({ error: 'MONITOR_NOT_ATTACHABLE' }, 400));
  const onAttached = vi.fn();
  render(<RecommendedMonitors rows={[monitor]} onAttached={onAttached} />);
  fireEvent.click(screen.getByTestId('recommended-open'));
  await screen.findByText('Servers');
  fireEvent.change(screen.getByTestId('recommended-policy'), { target: { value: policyId } });
  fireEvent.click(screen.getByTestId('recommended-attach'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  expect(onAttached).not.toHaveBeenCalled();
});
