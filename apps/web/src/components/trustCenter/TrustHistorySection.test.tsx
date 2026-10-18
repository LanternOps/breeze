// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@/lib/i18n';
const api = vi.hoisted(() => ({ updateTrustPage: vi.fn() }));
vi.mock('@/lib/api/trustPage', () => api);
import TrustHistorySection from './TrustHistorySection';

const orgFetch = vi.fn() as never;
const mount = (opts: { canWrite?: boolean; value?: boolean; source?: string } = {}) => {
  const onReload = vi.fn(async () => {});
  const state = {
    page: { publicationRevision: 9 },
    effective: { values: { showHistory: opts.value ?? false }, sources: { showHistory: opts.source ?? 'default' } },
  };
  render(<TrustHistorySection orgId="o1" orgFetch={orgFetch} state={state as never} canWrite={opts.canWrite ?? true} onReload={onReload} />);
  return onReload;
};

describe('TrustHistorySection', () => {
  beforeEach(() => { vi.clearAllMocks(); api.updateTrustPage.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 })); });

  it('shows the effective value and where it comes from', () => {
    mount({ value: true, source: 'template' });
    expect(screen.getByTestId('trust-history-toggle')).toBeChecked();
    expect(screen.getByTestId('trust-history-source')).toHaveAttribute('data-source', 'template');
  });

  it('toggling saves the page value with expectedRevision and reloads', async () => {
    const onReload = mount();
    expect(screen.getByTestId('trust-history-source')).toHaveAttribute('data-source', 'default');
    fireEvent.click(screen.getByTestId('trust-history-toggle'));
    await waitFor(() => expect(api.updateTrustPage).toHaveBeenCalledWith(orgFetch, 'o1', { showHistory: true, expectedRevision: 9 }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
  });

  it('is disabled without write permission', () => {
    mount({ canWrite: false });
    expect(screen.getByTestId('trust-history-toggle')).toBeDisabled();
  });
});
