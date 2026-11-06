import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ findActiveWispGrant: vi.fn() }));
vi.mock('@/lib/wispSession', () => ({ findActiveWispGrant: h.findActiveWispGrant }));

import WispChatWelcome from './WispChatWelcome';

const lookup = (firstLookState: string | undefined, grantId = 'g1') => ({ kind: 'grant', grant: { grantId, firstLookState } });
const welcome = (over: Record<string, unknown> = {}) => (
  <WispChatWelcome grantId="g1" orgId={null} scopeLabel="Acme" onSuggest={vi.fn()} {...over} />
);

describe('WispChatWelcome (#11145: the side panel and the /ai/chat tab)', () => {
  beforeEach(() => { h.findActiveWispGrant.mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads the grant on open: a stale "looking" becomes what is true now', async () => {
    h.findActiveWispGrant.mockResolvedValue(lookup('couldnt_look'));
    render(welcome({ initialState: 'looking' }));
    expect(await screen.findByText("I couldn't look at Acme yet.")).toBeInTheDocument();
    expect(screen.getByTestId('wisp-welcome-couldnt-look')).toHaveTextContent('The Wisp home says why');
    expect(h.findActiveWispGrant).toHaveBeenCalledWith(null);
  });

  it('says "first look" once one exists', async () => {
    h.findActiveWispGrant.mockResolvedValue(lookup('done'));
    render(welcome({ initialState: 'looking' }));
    expect(await screen.findByText("I've had a first look at Acme.")).toBeInTheDocument();
  });

  it('keeps the greeting short: no brief line, no progress', async () => {
    h.findActiveWispGrant.mockResolvedValue(lookup('looking'));
    render(welcome({ initialState: 'looking' }));
    await waitFor(() => expect(h.findActiveWispGrant).toHaveBeenCalled());
    expect(screen.getByText("I'm looking around Acme.")).toBeInTheDocument();
    expect(screen.queryByText(/first brief/)).toBeNull();
    expect(screen.queryByTestId('wisp-welcome-progress')).toBeNull();
  });

  it('with no state and no answer it claims nothing: only the chips', async () => {
    h.findActiveWispGrant.mockResolvedValue({ kind: 'unknown' });
    render(welcome());
    await waitFor(() => expect(h.findActiveWispGrant).toHaveBeenCalled());
    expect(screen.queryByText(/looking around/)).toBeNull();
    expect(screen.queryByText(/first look/)).toBeNull();
    expect(screen.getAllByTestId('wisp-suggestion')).toHaveLength(4);
  });

  it("a failed read keeps what the panel already knew", async () => {
    h.findActiveWispGrant.mockResolvedValue({ kind: 'unknown' });
    render(welcome({ initialState: 'couldnt_look' }));
    await waitFor(() => expect(h.findActiveWispGrant).toHaveBeenCalled());
    expect(screen.getByText("I couldn't look at Acme yet.")).toBeInTheDocument();
  });

  it("another grant's answer is ignored (the lookup finds the org's own grant before a partner-wide one)", async () => {
    h.findActiveWispGrant.mockResolvedValue(lookup('done', 'g-other'));
    render(welcome({ initialState: 'looking' }));
    await waitFor(() => expect(h.findActiveWispGrant).toHaveBeenCalled());
    expect(screen.getByText("I'm looking around Acme.")).toBeInTheDocument();
  });

  it('re-reads while it could still change, and stops once the first look is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.findActiveWispGrant.mockResolvedValue(lookup('looking'));
    render(welcome({ initialState: 'looking' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(h.findActiveWispGrant).toHaveBeenCalledTimes(1);

    h.findActiveWispGrant.mockResolvedValue(lookup('couldnt_look'));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(h.findActiveWispGrant).toHaveBeenCalledTimes(2);
    expect(screen.getByText("I couldn't look at Acme yet.")).toBeInTheDocument();

    h.findActiveWispGrant.mockResolvedValue(lookup('done'));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText("I've had a first look at Acme.")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(h.findActiveWispGrant).toHaveBeenCalledTimes(3);
  });

  it('stops re-reading after the batch has had time to settle: an old grant that never posts must not poll for good', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.findActiveWispGrant.mockResolvedValue(lookup('looking'));
    render(welcome({ initialState: 'looking' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(40 * 60_000); });
    const reads = h.findActiveWispGrant.mock.calls.length;
    expect(reads).toBeGreaterThan(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000); });
    expect(h.findActiveWispGrant).toHaveBeenCalledTimes(reads);
  });

  it('a grant already known to be done never polls', async () => {
    h.findActiveWispGrant.mockResolvedValue(lookup('done'));
    render(welcome({ initialState: 'done' }));
    await waitFor(() => expect(screen.getByText("I've had a first look at Acme.")).toBeInTheDocument());
    expect(h.findActiveWispGrant).not.toHaveBeenCalled();
  });

  it('stops reading when it unmounts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.findActiveWispGrant.mockResolvedValue(lookup('looking'));
    const { unmount } = render(welcome({ initialState: 'looking' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(h.findActiveWispGrant).toHaveBeenCalledTimes(1);
  });
});
