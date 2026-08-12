import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QuickLandingPage, { detectQuickClient } from './QuickLandingPage';

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

/** Real-world UA strings, so the detector is exercised against what ships. */
const UA = {
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  windowsFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
} as const;

/**
 * jsdom's own UA parses as an unknown platform, so the default render exercises
 * the generic path. Tests that care about a platform stub navigator instead.
 */
function stubUserAgent(userAgent: string, platformHint?: string) {
  vi.stubGlobal('navigator', {
    ...window.navigator,
    userAgent,
    ...(platformHint ? { userAgentData: { platform: platformHint } } : {}),
  });
}

describe('detectQuickClient', () => {
  it.each([
    ['windows', UA.windowsChrome],
    ['macos', UA.macSafari],
    ['ios', UA.iphone],
    ['android', UA.android],
    ['linux', UA.linux],
  ])('detects %s from the user agent', (os, userAgent) => {
    expect(detectQuickClient(userAgent).os).toBe(os);
  });

  it('prefers the userAgentData platform hint over the user agent', () => {
    // A Windows browser freezing its UA to a generic string still resolves.
    expect(detectQuickClient(UA.macSafari, 'Windows').os).toBe('windows');
  });

  it('does not read an Android device as Linux', () => {
    // Every Android UA also says "Linux" — ordering is what keeps this right.
    expect(detectQuickClient(UA.android).os).toBe('android');
  });

  it('does not read an iPhone as a Mac', () => {
    // Every iOS UA says "like Mac OS X".
    expect(detectQuickClient(UA.iphone).os).toBe('ios');
  });

  it('reads a touch iPad (desktop Mac UA) as iOS, but a real Mac as macOS', () => {
    // iPadOS Safari sends a "Macintosh; Intel Mac OS X" UA and no
    // userAgentData; maxTouchPoints is the only tell.
    expect(detectQuickClient(UA.macSafari, undefined, 5).os).toBe('ios');
    // A genuine Mac reports 0 touch points and must stay macOS.
    expect(detectQuickClient(UA.macSafari, undefined, 0).os).toBe('macos');
    expect(detectQuickClient(UA.macSafari).os).toBe('macos');
  });

  it('falls back to unknown rather than guessing', () => {
    expect(detectQuickClient('').os).toBe('unknown');
    expect(detectQuickClient('Mozilla/5.0 (jsdom)').os).toBe('unknown');
  });

  it.each([
    ['edge', UA.windowsEdge],
    ['chrome', UA.windowsChrome],
    ['other', UA.windowsFirefox],
  ])('detects the %s browser', (browser, userAgent) => {
    // Edge carries "Chrome/" too, so it must not be reported as Chrome.
    expect(detectQuickClient(userAgent).browser).toBe(browser);
  });
});

describe('QuickLandingPage', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/quick');
    vi.unstubAllGlobals();
  });

  afterEach(() => {
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

  it('shows the three numbered steps up front', async () => {
    mockFetch(() => jsonResponse({ valid: true }));

    render(<QuickLandingPage />);

    expect(await screen.findByTestId('quick-steps')).toBeInTheDocument();
    expect(screen.getByTestId('quick-step-1')).toHaveTextContent(
      'Enter the code your technician gave you',
    );
    expect(screen.getByTestId('quick-step-2')).toHaveTextContent('Download the support app');
    expect(screen.getByTestId('quick-step-3')).toHaveTextContent(
      'Run it and approve the Windows prompt',
    );
  });

  it('offers a numeric keypad without rejecting legacy letter codes', async () => {
    mockFetch(() => jsonResponse({ valid: true }));

    render(<QuickLandingPage />);

    const input = await screen.findByTestId('quick-code-input');
    expect(input).toHaveAttribute('type', 'text');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).not.toHaveAttribute('pattern');
    expect(input).toHaveAttribute('placeholder', '234-567-892');
  });

  it('checks the normalized code from the URL and offers the Windows download', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ valid: true }));
    window.history.replaceState({}, '', '/quick?code=234-567-892');

    render(<QuickLandingPage />);

    const download = await screen.findByTestId('quick-download-windows');
    expect(requestedUrls(fetchMock)).toEqual(['/api/v1/support/check/234567892']);
    expect(download.getAttribute('href')).toBe(
      '/api/v1/support/download/windows?code=234567892',
    );
    expect(screen.queryByTestId('quick-invalid-code')).not.toBeInTheDocument();
  });

  it('shows the manual fallback line with the dashed code', async () => {
    mockFetch(() => jsonResponse({ valid: true }));
    window.history.replaceState({}, '', '/quick?code=234567892');

    render(<QuickLandingPage />);

    expect(
      await screen.findByText('If the download prompts for a code, enter: 234-567-892'),
    ).toBeInTheDocument();
  });

  it('hides the download button and explains when the code is rejected', async () => {
    mockFetch(() => jsonResponse({ valid: false }));
    window.history.replaceState({}, '', '/quick?code=234-567-892');

    render(<QuickLandingPage />);

    expect(await screen.findByTestId('quick-invalid-code')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
    // The user can still try a fresh code the technician reads out.
    expect(screen.getByTestId('quick-code-input')).toBeInTheDocument();
  });

  it('normalizes lower-case spaced legacy input typed into the form', async () => {
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

    await user.type(screen.getByTestId('quick-code-input'), '234-567');
    await user.click(screen.getByTestId('quick-code-submit'));

    expect(await screen.findByTestId('quick-code-format-error')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
  });

  it('shows a rate-limit notice, not an invalid-code error, on a 429', async () => {
    // A rate-limited code may be perfectly valid; the user just tried too fast.
    mockFetch(
      () => ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response,
    );
    window.history.replaceState({}, '', '/quick?code=234-567-892');

    render(<QuickLandingPage />);

    expect(await screen.findByTestId('quick-rate-limited')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-invalid-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
    // The code entry form stays available so the user can retry.
    expect(screen.getByTestId('quick-code-input')).toBeInTheDocument();
  });

  it('does not claim the code is dead when the network request fails', async () => {
    mockFetch(() => {
      throw new Error('offline');
    });
    window.history.replaceState({}, '', '/quick?code=234-567-892');

    render(<QuickLandingPage />);

    expect(await screen.findByTestId('quick-check-error')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-invalid-code')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
  });

  it('shows a disabled macOS row marked coming soon on a non-Mac', async () => {
    mockFetch(() => jsonResponse({ valid: true }));
    window.history.replaceState({}, '', '/quick?code=234-567-892');

    render(<QuickLandingPage />);

    const macRow = await screen.findByTestId('quick-download-macos');
    expect(macRow).toHaveAttribute('aria-disabled', 'true');
    expect(macRow).toHaveTextContent('Coming soon');
    expect(macRow.querySelector('a')).toBeNull();
  });

  it('sets an honest Windows publisher expectation without naming a company', async () => {
    mockFetch(() => jsonResponse({ valid: true }));
    window.history.replaceState({}, '', '/quick?code=234-567-892');

    render(<QuickLandingPage />);

    await screen.findByTestId('quick-download-windows');
    expect(
      screen.getByText(/Windows shows a prompt asking whether you want to allow it to run/),
    ).toBeInTheDocument();
    expect(screen.getByText(/close the prompt and call the person helping you/)).toBeInTheDocument();
  });

  describe('partner branding', () => {
    const branding = {
      partnerName: 'Northwind IT',
      logoUrl: 'https://cdn.example.com/northwind.png',
      accentColor: '#1B4F9C',
      headline: 'Support you can call',
    };

    it('renders the partner name, logo, headline and accent when branding is present', async () => {
      mockFetch(() => jsonResponse({ valid: true, branding }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      const block = await screen.findByTestId('quick-branding');
      expect(block).toHaveTextContent('Northwind IT Quick Support');
      expect(block).toHaveTextContent('You are getting help from Northwind IT');
      expect(block).toHaveTextContent('Support you can call');
      expect(screen.getByTestId('quick-branding-logo')).toHaveAttribute(
        'src',
        'https://cdn.example.com/northwind.png',
      );
      expect(screen.getByTestId('quick-download-windows').getAttribute('style')).toContain(
        '#1B4F9C',
      );
    });

    it('keeps the generic look when the response carries no branding', async () => {
      mockFetch(() => jsonResponse({ valid: true, branding: null }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      await screen.findByTestId('quick-download-windows');
      expect(screen.queryByTestId('quick-branding')).not.toBeInTheDocument();
      expect(screen.getByText('Start a support session')).toBeInTheDocument();
      expect(screen.getByTestId('quick-download-windows').getAttribute('style')).toBeNull();
    });

    it('drops a logo and accent that are not safe to render', async () => {
      mockFetch(() =>
        jsonResponse({
          valid: true,
          branding: {
            ...branding,
            logoUrl: 'javascript:alert(1)',
            accentColor: 'red;background:url(x)',
          },
        }),
      );
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      await screen.findByTestId('quick-branding');
      expect(screen.queryByTestId('quick-branding-logo')).not.toBeInTheDocument();
      expect(screen.getByTestId('quick-download-windows').getAttribute('style')).toBeNull();
    });

    it('shows no branding for an invalid code', async () => {
      mockFetch(() => jsonResponse({ valid: false }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      await screen.findByTestId('quick-invalid-code');
      expect(screen.queryByTestId('quick-branding')).not.toBeInTheDocument();
    });
  });

  describe('platform-specific guidance', () => {
    it('adds the SmartScreen keep hint on Edge', async () => {
      stubUserAgent(UA.windowsEdge);
      mockFetch(() => jsonResponse({ valid: true }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      expect(await screen.findByTestId('quick-browser-hint')).toHaveTextContent('Microsoft Edge');
      expect(screen.getByTestId('quick-download-windows')).toBeInTheDocument();
      expect(screen.queryByTestId('quick-platform-note')).not.toBeInTheDocument();
    });

    it('adds the Chrome keep hint on Chrome', async () => {
      stubUserAgent(UA.windowsChrome);
      mockFetch(() => jsonResponse({ valid: true }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      expect(await screen.findByTestId('quick-browser-hint')).toHaveTextContent('Google Chrome');
    });

    it('falls back to a generic keep hint on other Windows browsers', async () => {
      stubUserAgent(UA.windowsFirefox);
      mockFetch(() => jsonResponse({ valid: true }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      expect(await screen.findByTestId('quick-browser-hint')).toHaveTextContent(
        'If your browser asks whether to keep the file',
      );
    });

    it('shows macOS unavailable and never offers the Windows download on a Mac', async () => {
      stubUserAgent(UA.macSafari);
      mockFetch(() => jsonResponse({ valid: true }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      const macBlock = await screen.findByTestId('quick-download-macos');
      expect(macBlock).toHaveTextContent('not ready for Mac computers yet');
      expect(macBlock).toHaveTextContent('Do not download the Windows program');
      expect(macBlock).not.toHaveTextContent('Coming soon');
      // A Mac cannot run the Windows .exe — never offer it here.
      expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
      expect(screen.queryByTestId('quick-browser-hint')).not.toBeInTheDocument();
    });

    it.each([
      ['iOS', UA.iphone],
      ['Android', UA.android],
    ])('tells a %s visitor to move to the PC and hides the download', async (_name, userAgent) => {
      stubUserAgent(userAgent);
      mockFetch(() => jsonResponse({ valid: true }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      const notice = await screen.findByTestId('quick-mobile-notice');
      expect(notice).toHaveTextContent('Open this page on the Windows computer that needs help');
      expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
      expect(screen.queryByTestId('quick-download-macos')).not.toBeInTheDocument();
    });

    it('treats a touch iPad (desktop Mac UA) as mobile and shows the go-to-PC notice', async () => {
      // iPadOS Safari sends a Mac UA; only maxTouchPoints separates it from a
      // real Mac. Without this it would land on the useless Mac download block.
      vi.stubGlobal('navigator', {
        ...window.navigator,
        userAgent: UA.macSafari,
        maxTouchPoints: 5,
      });
      mockFetch(() => jsonResponse({ valid: true }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      expect(await screen.findByTestId('quick-mobile-notice')).toBeInTheDocument();
      expect(screen.queryByTestId('quick-download-windows')).not.toBeInTheDocument();
      expect(screen.queryByTestId('quick-download-macos')).not.toBeInTheDocument();
    });

    it('explains that downloads are Windows-only on Linux', async () => {
      stubUserAgent(UA.linux);
      mockFetch(() => jsonResponse({ valid: true }));
      window.history.replaceState({}, '', '/quick?code=234-567-892');

      render(<QuickLandingPage />);

      expect(await screen.findByTestId('quick-platform-note')).toHaveTextContent(
        'only available for Windows computers',
      );
      // Detection is advisory — the download stays reachable.
      expect(screen.getByTestId('quick-download-windows')).toBeInTheDocument();
    });
  });
});
