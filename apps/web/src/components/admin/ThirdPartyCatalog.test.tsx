import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ThirdPartyCatalog from './ThirdPartyCatalog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const sampleItems = [
  {
    id: '1',
    source: 'third_party',
    packageId: 'Mozilla.Firefox',
    vendor: 'Mozilla',
    friendlyName: 'Mozilla Firefox',
    category: 'application',
    defaultSeverity: 'important',
    breezeTested: true,
    lastTestedAt: null,
    lastTestedVersion: null,
    lastTestedResult: null,
    notes: null,
    homepageUrl: 'https://www.mozilla.org/firefox/',
  },
  {
    id: '2',
    source: 'third_party',
    packageId: 'Google.Chrome',
    vendor: 'Google',
    friendlyName: 'Google Chrome',
    category: 'application',
    defaultSeverity: 'important',
    breezeTested: false,
    lastTestedAt: null,
    lastTestedVersion: null,
    lastTestedResult: null,
    notes: null,
    homepageUrl: null,
  },
];

describe('ThirdPartyCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ items: sampleItems, total: sampleItems.length }));
  });

  it('renders entries with vendor, package name, and winget id', async () => {
    render(<ThirdPartyCatalog />);
    await screen.findByText('Mozilla Firefox');
    expect(screen.getByText('Google Chrome')).toBeTruthy();
    expect(screen.getByText('Mozilla.Firefox')).toBeTruthy();
    expect(screen.getByText('Google.Chrome')).toBeTruthy();
  });

  it('shows breeze-tested badge only on tested entries', async () => {
    render(<ThirdPartyCatalog />);
    await screen.findByText('Mozilla Firefox');
    expect(screen.getByTestId('catalog-row-1-tested-badge')).toBeTruthy();
    expect(screen.queryByTestId('catalog-row-2-tested-badge')).toBeNull();
  });

  it('shows total count', async () => {
    render(<ThirdPartyCatalog />);
    await waitFor(() => {
      expect(screen.getByTestId('catalog-total').textContent).toBe('2');
    });
  });

  it('refetches with search query when search input changes', async () => {
    render(<ThirdPartyCatalog />);
    await screen.findByText('Mozilla Firefox');

    fireEvent.change(screen.getByTestId('catalog-search'), { target: { value: 'firefox' } });

    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1)?.[0];
      expect(String(last)).toContain('search=firefox');
    });
  });

  it('refetches with breezeTested=true when filter checkbox toggled', async () => {
    render(<ThirdPartyCatalog />);
    await screen.findByText('Mozilla Firefox');

    fireEvent.click(screen.getByTestId('catalog-filter-tested'));

    await waitFor(() => {
      const last = fetchMock.mock.calls.at(-1)?.[0];
      expect(String(last)).toContain('breezeTested=true');
    });
  });

  it('shows empty state when no items returned', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ items: [], total: 0 }));
    render(<ThirdPartyCatalog />);
    await screen.findByTestId('catalog-empty');
  });

  it('shows error state on fetch failure', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({}, false));
    render(<ThirdPartyCatalog />);
    await screen.findByText('Failed to load catalog');
  });

  it('opens the editor when "Add package" is clicked', async () => {
    render(<ThirdPartyCatalog />);
    await screen.findByText('Mozilla Firefox');

    fireEvent.click(screen.getByTestId('catalog-add-button'));

    expect(screen.getByTestId('catalog-editor-modal')).toBeTruthy();
    expect(screen.getByText('Add catalog entry')).toBeTruthy();
  });

  it('opens the editor pre-filled when edit row clicked', async () => {
    render(<ThirdPartyCatalog />);
    await screen.findByText('Mozilla Firefox');

    fireEvent.click(screen.getByTestId('catalog-row-1-edit'));

    expect(screen.getByTestId('catalog-editor-modal')).toBeTruthy();
    expect(screen.getByText('Edit catalog entry')).toBeTruthy();
    expect((screen.getByTestId('catalog-editor-packageId') as HTMLInputElement).value).toBe('Mozilla.Firefox');
    expect((screen.getByTestId('catalog-editor-vendor') as HTMLInputElement).value).toBe('Mozilla');
  });

  it('POSTs new entry when editor submitted', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (method === 'POST' && url === '/third-party-catalog') {
        return makeJsonResponse({ id: 'new', packageId: 'Foo.Bar', vendor: 'Foo', friendlyName: 'Foo Bar' });
      }
      return makeJsonResponse({ items: sampleItems, total: sampleItems.length });
    });

    render(<ThirdPartyCatalog />);
    await screen.findByText('Mozilla Firefox');

    fireEvent.click(screen.getByTestId('catalog-add-button'));
    fireEvent.change(screen.getByTestId('catalog-editor-packageId'), { target: { value: 'Foo.Bar' } });
    fireEvent.change(screen.getByTestId('catalog-editor-vendor'), { target: { value: 'Foo' } });
    fireEvent.change(screen.getByTestId('catalog-editor-friendlyName'), { target: { value: 'Foo Bar' } });
    fireEvent.click(screen.getByTestId('catalog-editor-submit'));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url) === '/third-party-catalog' && (init as RequestInit | undefined)?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(String((postCall![1] as RequestInit).body));
      expect(body.packageId).toBe('Foo.Bar');
      expect(body.vendor).toBe('Foo');
      expect(body.friendlyName).toBe('Foo Bar');
    });
  });

  it('PATCHes existing entry on edit submit', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (method === 'PATCH') {
        return makeJsonResponse({ id: '1', vendor: 'Mozilla Inc.' });
      }
      return makeJsonResponse({ items: sampleItems, total: sampleItems.length });
    });

    render(<ThirdPartyCatalog />);
    await screen.findByText('Mozilla Firefox');

    fireEvent.click(screen.getByTestId('catalog-row-1-edit'));
    fireEvent.change(screen.getByTestId('catalog-editor-vendor'), { target: { value: 'Mozilla Inc.' } });
    fireEvent.click(screen.getByTestId('catalog-editor-submit'));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url) === '/third-party-catalog/1' && (init as RequestInit | undefined)?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('DELETEs entry after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (method === 'DELETE') {
        return makeJsonResponse({ deleted: true });
      }
      return makeJsonResponse({ items: sampleItems, total: sampleItems.length });
    });

    render(<ThirdPartyCatalog />);
    await screen.findByText('Mozilla Firefox');

    fireEvent.click(screen.getByTestId('catalog-row-1-delete'));

    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url) === '/third-party-catalog/1' && (init as RequestInit | undefined)?.method === 'DELETE'
      );
      expect(deleteCall).toBeDefined();
    });

    confirmSpy.mockRestore();
  });
});
