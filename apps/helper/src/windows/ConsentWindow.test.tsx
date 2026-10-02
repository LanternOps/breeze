// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsentWindow, type ConsentWindowApi } from './ConsentWindow';
import type { ConsentRequest } from './ConsentDialog';

// The consent window is the Assist side of the consent prompt exchange with
// the agent: it confirms the prompt is on screen (v2 only), reports the
// user's click, and — v2 only — reports that the countdown ran out. A v1
// prompt (no nonce, older agent) stays silent on expiry, exactly as before.

const v2Req: ConsentRequest = {
  sessionId: 'sess-1',
  technicianName: 'Billy',
  technicianEmail: null,
  orgName: 'Olive Technology',
  timeoutMs: 3_000,
  onTimeout: 'proceed',
  nonce: 'nonce-1',
};
const v1Req: ConsentRequest = { ...v2Req, nonce: null };

function fakeApi(initial: ConsentRequest | null) {
  let push: ((req: ConsentRequest) => void) | undefined;
  const api: ConsentWindowApi = {
    getRequest: vi.fn(async () => initial),
    listen: vi.fn(async (cb: (req: ConsentRequest) => void) => {
      push = cb;
      return () => {};
    }),
    presented: vi.fn(async () => {}),
    submit: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isVisible: vi.fn(() => true),
  };
  return { api, push: (req: ConsentRequest) => push?.(req) };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ConsentWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // requestAnimationFrame is how the window waits for the prompt to paint.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('pulls the request on mount, so an event emitted before it was listening is not lost', async () => {
    const { api } = fakeApi(v2Req);
    render(<ConsentWindow api={api} />);
    await flush();
    expect(api.getRequest).toHaveBeenCalled();
    expect(screen.getByText('Billy')).toBeInTheDocument();
  });

  it('confirms a v2 prompt is on screen once it has painted, exactly once', async () => {
    const { api } = fakeApi(v2Req);
    render(<ConsentWindow api={api} />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(api.presented).toHaveBeenCalledTimes(1);
    expect(api.presented).toHaveBeenCalledWith('nonce-1');
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(api.presented).toHaveBeenCalledTimes(1);
  });

  it('does not confirm presentation while the window is not visible', async () => {
    const { api } = fakeApi(v2Req);
    vi.mocked(api.isVisible).mockReturnValue(false);
    render(<ConsentWindow api={api} />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
    expect(api.presented).not.toHaveBeenCalled();
  });

  it('does not run a v2 countdown until the prompt is confirmed on screen', async () => {
    const { api } = fakeApi(v2Req);
    vi.mocked(api.isVisible).mockReturnValue(false);
    render(<ConsentWindow api={api} />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(api.submit).not.toHaveBeenCalled();

    // Once visible, the full countdown runs from the confirmation.
    vi.mocked(api.isVisible).mockReturnValue(true);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(api.presented).toHaveBeenCalledWith('nonce-1');
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(api.submit).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    expect(api.submit).toHaveBeenCalledWith('sess-1', 'expired', 'nonce-1');
  });

  it('never confirms presentation for a v1 prompt', async () => {
    const { api } = fakeApi(v1Req);
    render(<ConsentWindow api={api} />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(api.presented).not.toHaveBeenCalled();
  });

  it('reports Allow and Deny with the nonce and closes', async () => {
    const { api } = fakeApi(v2Req);
    render(<ConsentWindow api={api} />);
    await flush();
    fireEvent.click(screen.getByText('Allow'));
    expect(api.submit).toHaveBeenCalledWith('sess-1', 'allow', 'nonce-1');
    expect(api.close).toHaveBeenCalled();
  });

  it('reports an expired v2 countdown as expired, not as the policy verdict', async () => {
    const { api } = fakeApi(v2Req);
    render(<ConsentWindow api={api} />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(20); // painted and confirmed; the countdown starts
    });
    await act(async () => {
      vi.advanceTimersByTime(3_500);
    });
    expect(api.submit).toHaveBeenCalledWith('sess-1', 'expired', 'nonce-1');
    expect(api.submit).not.toHaveBeenCalledWith('sess-1', 'allow', expect.anything());
  });

  it('stays silent when a v1 countdown expires (the older agent applies its own timeout)', async () => {
    const { api } = fakeApi(v1Req);
    render(<ConsentWindow api={api} />);
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(3_500);
    });
    expect(api.submit).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalled();
  });

  it('shows a request pushed after mount', async () => {
    const { api, push } = fakeApi(null);
    render(<ConsentWindow api={api} />);
    await flush();
    expect(screen.queryByText('Billy')).not.toBeInTheDocument();
    await act(async () => {
      push(v2Req);
    });
    expect(screen.getByText('Billy')).toBeInTheDocument();
  });
});
