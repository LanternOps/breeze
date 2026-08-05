import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QuickLandingPage from './QuickLandingPage';

function mockFetch(implementation: (url: string) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => implementation(String(input)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

function requestedUrls(fetchMock: ReturnType<typeof mockFetch>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

describe('QuickLandingPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/quick');
    vi.unstubAllGlobals();
  });

  it('shows the code entry form and no download when the URL carries no code', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ valid: true }));

    render(<QuickLandingPage />);

    expect(await screen.findByTestId('quick-code-input')).toBeInTheDocument();
    expect(screen.getByTestId('quick-code-submit')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks the normalized code from the URL and offers the Windows download', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ valid: true }));
    window.history.replaceState({}, '', '/quick?code=ktm-4h7-p2x');

    render(<QuickLandingPage />);

    const download = await screen.findByTestId('quick-download-windows');
    expect(requestedUrls(fetchMock)).toEqual(['/api/v1/support/check/KTM4H7P2X']);
    expect(download.getAttribute('href')).toBe(
      '/api/v1/support/download/windows?code=KTM4H7P2X',
    );
    expect(screen.queryByTestId('quick-invalid-code')).not.toBeInTheDocument();
  });

  it('shows the manual fallback line with the dashed code', async () => {
    mockFetch(() => jsonResponse({ valid: true }));
    window.history.replaceState({}, '', '/quick?code=KTM4H7P2X');

    render(<QuickLandingPage />);

    expect(
      await screen.findByText('If the download prompts for a code, enter: KTM-4H7-P2X'),
    ).toBeInTheDocument();
  });

  it('hides the download button and explains when the code is rejected', async () => {
    mockFetch(() => jsonResponse({ valid: false }));
    window.history.replaceState({}, '', '/quick?code=KTM-4H7-P2X');

    render(<QuickLandingPage />);

    expect(await screen.findByTestId('quick-invalid-code')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
    // The user can still try a fresh code the technician reads out.
    expect(screen.getByTestId('quick-code-input')).toBeInTheDocument();
  });

  it('normalizes lower-case spaced input typed into the form', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(() => jsonResponse({ valid: true }));

    render(<QuickLandingPage />);

    await user.type(screen.getByTestId('quick-code-input'), 'ktm 4h7 p2x');
    await user.click(screen.getByTestId('quick-code-submit'));

    await waitFor(() =>
      expect(requestedUrls(fetchMock)).toEqual(['/api/v1/support/check/KTM4H7P2X']),
    );
    expect(await screen.findByTestId('quick-download-windows')).toBeInTheDocument();
  });

  it('rejects an incomplete code locally without calling the API', async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch(() => jsonResponse({ valid: true }));

    render(<QuickLandingPage />);

    await user.type(screen.getByTestId('quick-code-input'), 'ktm-4h7');
    await user.click(screen.getByTestId('quick-code-submit'));

    expect(await screen.findByTestId('quick-code-format-error')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
  });

  it('does not claim the code is dead when the network request fails', async () => {
    mockFetch(() => {
      throw new Error('offline');
    });
    window.history.replaceState({}, '', '/quick?code=KTM-4H7-P2X');

    render(<QuickLandingPage />);

    expect(await screen.findByTestId('quick-check-error')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-invalid-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
  });

  it('shows a disabled macOS row marked coming soon', async () => {
    mockFetch(() => jsonResponse({ valid: true }));
    window.history.replaceState({}, '', '/quick?code=KTM-4H7-P2X');

    render(<QuickLandingPage />);

    const macRow = await screen.findByTestId('quick-download-macos');
    expect(macRow).toHaveAttribute('aria-disabled', 'true');
    expect(macRow).toHaveTextContent('Coming soon');
    expect(macRow.querySelector('a')).toBeNull();
  });

  it('sets an honest Windows publisher expectation without naming a company', async () => {
    mockFetch(() => jsonResponse({ valid: true }));
    window.history.replaceState({}, '', '/quick?code=KTM-4H7-P2X');

    render(<QuickLandingPage />);

    await screen.findByTestId('quick-download-windows');
    expect(
      screen.getByText(/Windows shows a prompt asking whether you want to allow it to run/),
    ).toBeInTheDocument();
    expect(screen.getByText(/close the prompt and call the person helping you/)).toBeInTheDocument();
  });
});
