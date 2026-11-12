import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));
const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({ fetchWithAuth }));

import TranscriptRetentionPreview, { TRANSCRIPT_PREVIEW_DEBOUNCE_MS, parseTranscriptPreview } from './TranscriptRetentionPreview';

const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 403, json: async () => body });
const settle = async (ms = TRANSCRIPT_PREVIEW_DEBOUNCE_MS) => {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => { vi.useRealTimers(); });

describe('parseTranscriptPreview', () => {
  it('accepts the frozen { eligible, capped, enforced } shape and rejects anything else', () => {
    expect(parseTranscriptPreview({ eligible: 3, capped: false, enforced: true })).toEqual({ eligible: 3, capped: false, enforced: true });
    expect(parseTranscriptPreview({ eligible: '3', capped: false, enforced: true })).toBeNull();
    expect(parseTranscriptPreview({ policy: null })).toBeNull();
    expect(parseTranscriptPreview(null)).toBeNull();
  });
});

describe('TranscriptRetentionPreview', () => {
  it('debounces: only the last url within the window is fetched', async () => {
    fetchWithAuth.mockResolvedValue(json({ eligible: 2, capped: false, enforced: false }));
    const { rerender } = render(<TranscriptRetentionPreview url="/p?days=1" scope="org" testId="pv" />);
    rerender(<TranscriptRetentionPreview url="/p?days=12" scope="org" testId="pv" />);
    rerender(<TranscriptRetentionPreview url="/p?days=120" scope="org" testId="pv" />);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    await settle();
    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    expect(fetchWithAuth).toHaveBeenCalledWith('/p?days=120', expect.objectContaining({ signal: expect.anything() }));
  });

  it('says plainly that nothing is deleted yet while enforcement is off', async () => {
    fetchWithAuth.mockResolvedValue(json({ eligible: 2, capped: false, enforced: false }));
    render(<TranscriptRetentionPreview url="/p?days=30" scope="org" testId="pv" />);
    await settle();
    const el = screen.getByTestId('pv');
    expect(el).toHaveTextContent('transcriptRetention.preview.orgPending');
    expect(el).toHaveTextContent('"count":2');
    expect(el).toHaveAttribute('data-enforced', 'false');
  });

  it('switches to the next-nightly-run copy when enforcement is on', async () => {
    fetchWithAuth.mockResolvedValue(json({ eligible: 2, capped: false, enforced: true }));
    render(<TranscriptRetentionPreview url="/p?days=30" scope="org" testId="pv" />);
    await settle();
    expect(screen.getByTestId('pv')).toHaveTextContent('transcriptRetention.preview.orgEnforced');
    expect(screen.getByTestId('pv')).toHaveAttribute('data-enforced', 'true');
  });

  it('labels the partner figure "up to" and renders a capped count as N+', async () => {
    fetchWithAuth.mockResolvedValue(json({ eligible: 10000, capped: true, enforced: false }));
    render(<TranscriptRetentionPreview url="/p?days=30" scope="partner" testId="pv" />);
    await settle();
    const el = screen.getByTestId('pv');
    expect(el).toHaveTextContent('transcriptRetention.preview.partnerPending');
    expect(el.textContent).toMatch(/"display":"10[,.\s  ]?000\+"/);
  });

  it('has a zero copy for each enforcement state', async () => {
    fetchWithAuth.mockResolvedValue(json({ eligible: 0, capped: false, enforced: false }));
    const { unmount } = render(<TranscriptRetentionPreview url="/p?days=30" scope="org" testId="pv" />);
    await settle();
    expect(screen.getByTestId('pv')).toHaveTextContent('transcriptRetention.preview.nonePending');
    unmount();
    fetchWithAuth.mockResolvedValue(json({ eligible: 0, capped: false, enforced: true }));
    render(<TranscriptRetentionPreview url="/p?days=31" scope="org" testId="pv" />);
    await settle();
    expect(screen.getByTestId('pv')).toHaveTextContent('transcriptRetention.preview.noneEnforced');
  });

  it('shows an unavailable line, not a stale or invented count, when the preview fails', async () => {
    fetchWithAuth.mockResolvedValue(json({ error: 'Forbidden' }, false));
    render(<TranscriptRetentionPreview url="/p?days=30" scope="org" testId="pv" />);
    await settle();
    expect(screen.getByTestId('pv')).toHaveTextContent('transcriptRetention.preview.unavailable');
  });

  it('renders nothing and fetches nothing when there is no window (keep forever / invalid days)', async () => {
    render(<TranscriptRetentionPreview url={null} scope="org" testId="pv" />);
    await settle();
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.queryByTestId('pv')).toBeNull();
  });
});
