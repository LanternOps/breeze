import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const previewSeriesRecipients = vi.fn();
vi.mock('./seriesApi', () => ({ previewSeriesRecipients: (...a: unknown[]) => previewSeriesRecipients(...a) }));

import { PREVIEW_DEBOUNCE_MS, SeriesRecipientsSection, type SeriesRecipientsValue } from './SeriesRecipientsSection';

const base: SeriesRecipientsValue = { recipientRule: { primaryContact: true, roles: [] }, internalCc: [] };
const all = { targetMode: 'all' as const, orgIds: [] };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function flushDebounce() {
  await act(async () => { vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS); });
}

describe('SeriesRecipientsSection', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
  afterEach(() => vi.useRealTimers());

  it('emits rule changes for the primary contact and a role', () => {
    previewSeriesRecipients.mockReturnValue(new Promise(() => {}));
    const onChange = vi.fn();
    render(<SeriesRecipientsSection value={base} onChange={onChange} targets={all} />);
    fireEvent.click(screen.getByTestId('series-rule-primary'));
    expect(onChange).toHaveBeenLastCalledWith({ ...base, recipientRule: { primaryContact: false, roles: [] } });
    fireEvent.click(screen.getByTestId('series-rule-role-billing'));
    expect(onChange).toHaveBeenLastCalledWith({ ...base, recipientRule: { primaryContact: true, roles: ['billing'] } });
  });

  it('previews after the debounce and names the orgs with no customer recipient', async () => {
    previewSeriesRecipients.mockResolvedValue({
      totalCustomerRecipients: 23, orgCount: 17,
      orgsWithoutCustomerRecipient: [{ orgId: 'o-9', orgName: 'Acme Dental' }],
    });
    render(<SeriesRecipientsSection value={base} onChange={vi.fn()} targets={all} />);
    expect(previewSeriesRecipients).not.toHaveBeenCalled();
    await flushDebounce();
    expect(previewSeriesRecipients).toHaveBeenCalledWith({ targetMode: 'all', orgIds: [], recipientRule: base.recipientRule, internalCc: [] });
    const preview = screen.getByTestId('series-recipient-preview');
    expect(preview).toHaveAttribute('data-state', 'ready');
    expect(preview).toHaveTextContent('Resolves to 23 contacts across 17 organizations');
    expect(screen.getByTestId('series-recipient-preview-missing')).toHaveTextContent('1 organization has no customer recipient: Acme Dental');
  });

  // Review Focus 2.
  it('keeps the newest preview when an older response lands last', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    previewSeriesRecipients.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<SeriesRecipientsSection value={base} onChange={vi.fn()} targets={all} />);
    await flushDebounce();
    rerender(<SeriesRecipientsSection value={{ ...base, recipientRule: { primaryContact: true, roles: ['billing'] } }} onChange={vi.fn()} targets={all} />);
    await flushDebounce();
    await act(async () => { second.resolve({ totalCustomerRecipients: 40, orgCount: 18, orgsWithoutCustomerRecipient: [] }); });
    await act(async () => { first.resolve({ totalCustomerRecipients: 5, orgCount: 18, orgsWithoutCustomerRecipient: [] }); });
    expect(screen.getByTestId('series-recipient-preview')).toHaveTextContent('Resolves to 40 contacts');
  });

  it('does not preview a Chosen-organizations series with nothing chosen', async () => {
    render(<SeriesRecipientsSection value={base} onChange={vi.fn()} targets={{ targetMode: 'selected', orgIds: [] }} />);
    await flushDebounce();
    expect(previewSeriesRecipients).not.toHaveBeenCalled();
    expect(screen.getByTestId('series-recipient-preview')).toHaveAttribute('data-state', 'idle');
  });

  it('shows an inline failure without throwing', async () => {
    previewSeriesRecipients.mockRejectedValue(new Error('boom'));
    render(<SeriesRecipientsSection value={base} onChange={vi.fn()} targets={all} />);
    await flushDebounce();
    expect(screen.getByTestId('series-recipient-preview')).toHaveAttribute('data-state', 'failed');
  });

  it('validates and adds an internal CC, and warns when no rule is selected', () => {
    previewSeriesRecipients.mockReturnValue(new Promise(() => {}));
    const onChange = vi.fn();
    render(<SeriesRecipientsSection value={{ recipientRule: { primaryContact: false, roles: [] }, internalCc: [] }} onChange={onChange} targets={all} />);
    expect(screen.getByTestId('series-rule-none-warning')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('series-cc-input'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('series-cc-add'));
    expect(screen.getByTestId('series-cc-error')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('series-cc-input'), { target: { value: 'ops@msp.example' } });
    fireEvent.click(screen.getByTestId('series-cc-add'));
    expect(onChange).toHaveBeenCalledWith({ recipientRule: { primaryContact: false, roles: [] }, internalCc: ['ops@msp.example'] });
  });
});
