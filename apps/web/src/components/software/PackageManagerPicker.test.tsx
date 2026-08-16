import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PackageManagerPicker, { type SelectedPackageMethod } from './PackageManagerPicker';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const CHROME = {
  platform: 'windows',
  kind: 'winget',
  packageId: 'Google.Chrome',
  name: 'Google Chrome',
  vendor: 'Google',
  latestVersion: '120.0',
  breezeTested: { version: '119.0', testedAt: '2026-08-01T00:00:00.000Z' },
};

const FIREFOX_CASK = {
  platform: 'macos',
  kind: 'homebrew_cask',
  packageId: 'firefox',
  name: 'Firefox',
  vendor: 'Mozilla',
};

/** Route mock keyed on the platform query param. */
function searchMock(byPlatform: { windows?: unknown; macos?: unknown }) {
  fetchMock.mockImplementation((url: string) => {
    if (!url.startsWith('/software/package-search')) {
      return Promise.resolve(jsonResponse({}, false, 404));
    }
    const platform = new URL(url, 'https://x').searchParams.get('platform');
    const payload =
      platform === 'macos'
        ? (byPlatform.macos ?? { results: [FIREFOX_CASK] })
        : (byPlatform.windows ?? { results: [CHROME] });
    return Promise.resolve(jsonResponse(payload));
  });
}

const typeQuery = (value: string) =>
  fireEvent.change(screen.getByLabelText('Search packages'), { target: { value } });

function renderPicker(methods: SelectedPackageMethod[] = []) {
  const onChange = vi.fn();
  const view = render(<PackageManagerPicker methods={methods} onChange={onChange} />);
  return { onChange, view };
}

describe('PackageManagerPicker', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('does not search until at least 2 characters are typed', async () => {
    searchMock({});
    renderPicker();

    typeQuery('c');
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('debounces the search to a single request for rapid keystrokes', async () => {
    searchMock({});
    renderPicker();

    typeQuery('ch');
    typeQuery('chr');
    typeQuery('chrome');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/software/package-search');
    expect(url).toContain('platform=windows');
    expect(url).toContain('q=chrome');

    // …and nothing further fires after the debounce window elapses.
    await new Promise((r) => setTimeout(r, 400));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('renders results with the Breeze-tested pill and adds a method chip on click', async () => {
    const { onChange } = renderPicker();
    searchMock({});

    typeQuery('chrome');
    expect(await screen.findByText('Google.Chrome')).toBeInTheDocument();
    expect(screen.getByText(/Breeze tested v119\.0/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Google Chrome/ }));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        platform: 'windows',
        kind: 'winget',
        packageId: 'Google.Chrome',
        name: 'Google Chrome',
        vendor: 'Google',
      }),
    ]);
  });

  it('replaces an existing selection for the same platform+kind (the API rejects duplicates)', async () => {
    const { onChange } = renderPicker([
      { platform: 'windows', kind: 'winget', packageId: 'Old.Package' },
    ]);
    searchMock({});

    typeQuery('chrome');
    fireEvent.click(await screen.findByRole('button', { name: /Google Chrome/ }));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ packageId: 'Google.Chrome', kind: 'winget' }),
    ]);
  });

  it('searches the macOS index when the platform tab is switched', async () => {
    renderPicker();
    searchMock({});

    typeQuery('firefox');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('tab', { name: 'macOS' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]![0])).toContain('platform=macos');
    expect(await screen.findByText('firefox')).toBeInTheDocument();
  });

  it('removes a selected method chip', () => {
    const methods: SelectedPackageMethod[] = [
      { platform: 'windows', kind: 'winget', packageId: 'Google.Chrome' },
      { platform: 'macos', kind: 'homebrew_cask', packageId: 'firefox' },
    ];
    searchMock({});
    const { onChange } = renderPicker(methods);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Google.Chrome' }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ packageId: 'firefox' }),
    ]);
  });

  it('shows the manual-entry hint when the search index reports degraded', async () => {
    searchMock({ windows: { results: [], degraded: true } });
    renderPicker();

    typeQuery('chrome');
    expect(
      await screen.findByText(/Package search is unavailable/i),
    ).toBeInTheDocument();
  });

  it('surfaces a failed search without throwing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'boom' }, false, 500));
    renderPicker();

    typeQuery('chrome');
    expect(await screen.findByText(/Package search failed/i)).toBeInTheDocument();
  });

  describe('manual entry', () => {
    const openManual = () =>
      fireEvent.click(screen.getByRole('button', { name: /Enter a package ID manually/i }));

    it('validates the package id against the winget rules', async () => {
      searchMock({});
      const { onChange } = renderPicker();
      openManual();

      fireEvent.change(screen.getByLabelText('Package ID'), { target: { value: 'bad id' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add package' }));

      expect(await screen.findByText('Invalid winget package ID')).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('validates against the Homebrew rules for a brew kind', async () => {
      searchMock({});
      const { onChange } = renderPicker();
      fireEvent.click(screen.getByRole('tab', { name: 'macOS' }));
      openManual();

      fireEvent.change(screen.getByLabelText('Package ID'), { target: { value: '../escape' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add package' }));

      expect(await screen.findByText('Invalid Homebrew package name')).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('adds a valid manual entry with the platform implied by the kind', async () => {
      searchMock({});
      const { onChange } = renderPicker();
      fireEvent.click(screen.getByRole('tab', { name: 'macOS' }));
      openManual();

      fireEvent.change(screen.getByLabelText('Package type'), {
        target: { value: 'homebrew_formula' },
      });
      fireEvent.change(screen.getByLabelText('Package ID'), { target: { value: 'node@22' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add package' }));

      expect(onChange).toHaveBeenCalledWith([
        { platform: 'macos', kind: 'homebrew_formula', packageId: 'node@22' },
      ]);
    });
  });
});
