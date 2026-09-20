import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuth, runAction, showToast, fetchPolicyPreview } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  runAction: vi.fn(async ({ request, parseSuccess }: { request: () => Promise<Response>; parseSuccess?: (d: unknown) => unknown }) => {
    const res = await request();
    const body = await res.json();
    return parseSuccess ? parseSuccess(body) : body;
  }),
  showToast: vi.fn(),
  fetchPolicyPreview: vi.fn(),
}));
vi.mock('../../../stores/auth', () => ({ fetchWithAuth }));
vi.mock('@/lib/runAction', () => ({
  runAction,
  ActionError: class ActionError extends Error { constructor(message: string, public status: number) { super(message); } },
}));
vi.mock('../../shared/Toast', () => ({ showToast }));
vi.mock('./conversionApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversionApi')>();
  return { ...actual, fetchPolicyPreview };
});

import NeedsConversionPanel from './NeedsConversionPanel';

const json = (body: unknown, status = 200): Response =>
  ({ ok: status < 300, status, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

const item = (over: Partial<import('./conversionApi').ConversionPreviewItem> = {}) => ({
  sourceTable: 'config_policy_alert_rules' as const, sourceId: 'src-1', name: 'CPU > 80', outcome: 'convertible' as const,
  proposed: [{ role: 'primary' as const, kind: 'cpu', name: 'CPU > 80', condition: { threshold: 80 }, severity: 'high', enabled: true, cooldownMinutes: 5, autoResolve: true, deliveryMode: 'inherit' as const, deliveryChannelIds: [], escalationPolicyId: null, responses: [] }],
  notes: ['Delivery: inherit (rule had no channels)'], openAlerts: 2, ...over,
});
const preview = (over: Record<string, unknown> = {}) => ({
  policyId: 'pol-1', previewHash: 'hash-1', items: [item()], inheritanceMode: 'replace',
  equivalence: { devicesChecked: 12, deltas: [] }, ...over,
});

beforeEach(() => { vi.clearAllMocks(); fetchPolicyPreview.mockReset(); fetchPolicyPreview.mockResolvedValue(preview()); });

describe('NeedsConversionPanel', () => {
it('shows missing prerequisites even when the blocked preview has no items', async () => {
  fetchPolicyPreview.mockResolvedValue(preview({ items: [], blockedBy: 'prerequisite_missing' }));
  render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
  expect(await screen.findByTestId('conversion-blocked')).toHaveTextContent(/prerequisite/i);
});

  it('cancels an in-flight preview when the policy changes or the panel unmounts', async () => {
    fetchPolicyPreview.mockImplementation(() => new Promise(() => {}));
    const view = render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    await waitFor(() => expect(fetchPolicyPreview).toHaveBeenCalledTimes(1));
    const first = fetchPolicyPreview.mock.calls[0]![1].signal as AbortSignal;
    view.rerender(<NeedsConversionPanel policyId="pol-2" hasLegacyRows onChanged={vi.fn()} />);
    await waitFor(() => expect(fetchPolicyPreview).toHaveBeenCalledTimes(2));
    expect(first.aborted).toBe(true);
    const second = fetchPolicyPreview.mock.calls[1]![1].signal as AbortSignal;
    view.unmount(); expect(second.aborted).toBe(true);
  });
  it('renders nothing and calls no API when the policy has no legacy rows', () => {
    const { container } = render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows={false} onChanged={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchPolicyPreview).not.toHaveBeenCalled();
  });

  it('renders nothing once the preview has no items left', async () => {
    fetchPolicyPreview.mockResolvedValue(preview({ items: [] }));
    const { container } = render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    await waitFor(() => expect(fetchPolicyPreview).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('lists each item with its source, proposed monitors, notes and open alerts', async () => {
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    const row = await screen.findByTestId('conversion-item-src-1');
    expect(row.textContent).toContain('CPU > 80');
    expect(row.textContent).toContain('Inline alert rule');
    expect(row.textContent).toContain('Delivery: inherit');
    expect(row.textContent).toMatch(/2 open alerts/);
    expect(screen.getByTestId('conversion-proposed-src-1-primary').textContent).toContain('cpu');
    expect(screen.getByText(/12 devices checked/)).toBeInTheDocument();
  });

  it('converts the full set with the preview hash, shows success and notifies history consumers', async () => {
    const onChanged = vi.fn();
    fetchWithAuth.mockResolvedValue(json({ data: { conversionIds: ['conv-1'], retired: 1, monitorsCreated: 1 } }));
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={onChanged} />);
    fireEvent.click(await screen.findByTestId('conversion-convert-all'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      '/monitor-definitions/conversion/policies/pol-1/convert',
      { method: 'POST', body: JSON.stringify({ previewHash: 'hash-1' }) },
    ));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchPolicyPreview).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('Convert all sends the full-set preview hash without a partial selection', async () => {
    fetchPolicyPreview.mockResolvedValue(preview({ items: [item(), item({ sourceId: 'src-2', name: 'Custom', outcome: 'unconvertible', reason: 'unconvertible:custom', proposed: [] })] }));
    fetchWithAuth.mockResolvedValue(json({ data: { conversionIds: ['conv-1'], retired: 1, monitorsCreated: 1 } }));
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('conversion-convert-all'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      '/monitor-definitions/conversion/policies/pol-1/convert',
      { method: 'POST', body: JSON.stringify({ previewHash: 'hash-1' }) },
    ));
  });

  it('shows the reason and a Retire action for an unconvertible item', async () => {
    fetchPolicyPreview.mockResolvedValue(preview({ items: [item({ outcome: 'unconvertible', reason: 'unconvertible:nested_group', proposed: [] })] }));
    fetchWithAuth.mockResolvedValue(json({ data: { conversionId: 'retire-1' } }));
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    const row = await screen.findByTestId('conversion-item-src-1');
    expect(row.textContent).toMatch(/nests condition groups/i);
    expect(screen.queryByTestId('conversion-convert-src-1')).toBeNull();
    expect(screen.queryByTestId('conversion-retire-reason-src-1')).toBeNull();
    fireEvent.click(screen.getByTestId('conversion-retire-src-1'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith(
      '/monitor-definitions/conversion/retire',
      { method: 'POST', body: JSON.stringify({ sourceTable: 'config_policy_alert_rules', sourceId: 'src-1', reason: 'unconvertible:nested_group' }) },
    ));
  });

  it('refuses to convert while the equivalence check reports deltas, and lists them', async () => {
    fetchPolicyPreview.mockResolvedValue(preview({ equivalence: { devicesChecked: 3, deltas: [{ deviceId: 'dev-9', detail: 'gains CPU > 80 (warning)' }] } }));
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    expect((await screen.findByTestId('conversion-convert-all')) as HTMLButtonElement).toBeDisabled();
    expect(screen.getByTestId('conversion-deltas').textContent).toContain('gains CPU > 80');
  });

  it('explains a blocked preview instead of offering Convert', async () => {
    fetchPolicyPreview.mockResolvedValue(preview({ blockedBy: 'parent_unconverted' }));
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    expect(await screen.findByTestId('conversion-blocked')).toHaveTextContent(/parent policy/i);
    expect((screen.getByTestId('conversion-convert-all') as HTMLButtonElement)).toBeDisabled();
  });
});

describe('NeedsConversionPanel async and failure safeguards', () => {
  it('offers no partial-selection action when multiple sources are convertible', async () => {
    fetchPolicyPreview.mockResolvedValue(preview({ items: [item(), item({ sourceId: 'src-2' })] }));
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    await screen.findByTestId('conversion-convert-all');
    expect(screen.queryByTestId('conversion-convert-src-1')).toBeNull();
    expect(screen.queryByTestId('conversion-convert-src-2')).toBeNull();
  });

  it('shows async progress and never offers a stale confirmation during refresh', async () => {
    fetchWithAuth.mockResolvedValue(json({ data: { conversionIds: ['conv-1'], retired: 1, monitorsCreated: 1 } }));
    fetchPolicyPreview.mockResolvedValueOnce(preview()).mockImplementationOnce((_id, options) => {
      options.onProgress({ checked: 500, total: 700 });
      return new Promise(() => {});
    });
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('conversion-convert-all'));
    const progress = await screen.findByTestId('conversion-progress');
    expect(progress).toHaveAttribute('value', '500');
    expect(progress).toHaveAttribute('max', '700');
    expect(screen.queryByTestId('conversion-convert-all')).toBeNull();
  });

  it('stops loading on terminal preview_failed and supports an explicit retry', async () => {
    fetchPolicyPreview.mockRejectedValueOnce(new Error('preview_failed')).mockResolvedValueOnce(preview());
    render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    expect(await screen.findByText('preview_failed')).toBeInTheDocument();
    expect(screen.queryByTestId('conversion-loading')).toBeNull();
    expect(fetchPolicyPreview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByTestId('conversion-convert-all')).toBeEnabled();
    expect(fetchPolicyPreview).toHaveBeenCalledTimes(2);
  });

  it('ignores a completed preview from an aborted policy request', async () => {
    let finish!: (value: unknown) => void;
    fetchPolicyPreview.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(preview({ policyId: 'pol-2', items: [item({ name: 'New policy' })] }));
    const view = render(<NeedsConversionPanel policyId="pol-1" hasLegacyRows onChanged={vi.fn()} />);
    view.rerender(<NeedsConversionPanel policyId="pol-2" hasLegacyRows onChanged={vi.fn()} />);
    await screen.findByText('New policy');
    await act(async () => { finish(preview()); });
    expect(screen.getByText('New policy')).toBeInTheDocument();
  });
});
