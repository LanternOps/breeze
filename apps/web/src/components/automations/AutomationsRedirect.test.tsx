import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

// `/automations` must not start a token refresh (#9476): the island may not
// load the auth store or anything built on it. These factories throw, so ANY
// import of them, direct or transitive, fails this whole file.
vi.mock('../../stores/auth', () => {
  throw new Error('AutomationsRedirect must not load stores/auth');
});
vi.mock('../../stores/featuresStore', () => {
  throw new Error('AutomationsRedirect must not load stores/featuresStore');
});

import AutomationsRedirect from './AutomationsRedirect';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AutomationsRedirect', () => {
  const replace = vi.fn();
  const fetchMock = vi.fn<typeof fetch>();
  const original = window.location;

  beforeEach(() => {
    replace.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, replace },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  /** Every request the island made: only the public config read, never /auth/refresh. */
  function requestedUrls(): string[] {
    return fetchMock.mock.calls.map(([input]) => String(input));
  }

  async function settle(): Promise<void> {
    // Let the fetch and body-read microtasks run.
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
  }

  it('reads the public config once, without the auth store, and sends Flows-on to /flows', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ features: { flows: true } }));
    render(<AutomationsRedirect />);
    await settle();

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/flows');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestedUrls()).toEqual(['/api/v1/config']);
    expect(requestedUrls().some((u) => u.includes('/auth/refresh'))).toBe(false);
    const init = fetchMock.mock.calls[0][1];
    expect(init?.credentials).toBe('same-origin');
    // A plain GET with no custom headers: no CORS preflight on split-origin installs.
    expect(init?.headers).toBeUndefined();
  });

  it('sends Flows-off to /jobs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ features: { flows: false } }));
    render(<AutomationsRedirect />);
    await settle();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/jobs');
    expect(requestedUrls()).toEqual(['/api/v1/config']);
  });

  it('sends a failed request to /jobs', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<AutomationsRedirect />);
    await settle();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/jobs');
  });

  it('sends a non-2xx answer to /jobs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ features: { flows: true } }, 503));
    render(<AutomationsRedirect />);
    await settle();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/jobs');
  });

  it.each([
    ['a body that is not JSON', () => new Response('<html>proxy error</html>', { status: 200 })],
    ['a string "true" flag', () => jsonResponse({ features: { flows: 'true' } })],
    ['no features object', () => jsonResponse({})],
    ['a null body', () => jsonResponse(null)],
  ])('sends %s to /jobs', async (_label, make) => {
    fetchMock.mockResolvedValue(make());
    render(<AutomationsRedirect />);
    await settle();
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/jobs');
  });

  it('goes to /jobs when the config read does not answer within the cap', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(new Promise<Response>(() => {}));
    render(<AutomationsRedirect />);
    await vi.advanceTimersByTimeAsync(2500);
    expect(replace).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith('/jobs');
  });

  it('navigates exactly once when the answer arrives after the cap', async () => {
    vi.useFakeTimers();
    let answer!: (res: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { answer = r; }));
    render(<AutomationsRedirect />);
    await vi.advanceTimersByTimeAsync(3500);
    expect(replace).toHaveBeenCalledWith('/jobs');

    answer(jsonResponse({ features: { flows: true } }));
    await vi.advanceTimersByTimeAsync(100);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('cancels the cap once the answer has navigated', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ features: { flows: true } }));
    render(<AutomationsRedirect />);
    await vi.advanceTimersByTimeAsync(10);
    expect(replace).toHaveBeenCalledWith('/flows');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('does not navigate after unmount', async () => {
    vi.useFakeTimers();
    let answer!: (res: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { answer = r; }));
    render(<AutomationsRedirect />).unmount();
    answer(jsonResponse({ features: { flows: true } }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(replace).not.toHaveBeenCalled();
  });
});
