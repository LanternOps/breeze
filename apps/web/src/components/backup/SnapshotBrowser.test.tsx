import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import SnapshotBrowser from './SnapshotBrowser';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('SnapshotBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/snapshots' && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Nightly Snapshot',
              createdAt: '2026-03-31T00:00:00Z',
              sizeBytes: 1048576,
              fileCount: 5,
              location: 'snapshots/provider-snap-1',
              expiresAt: '2026-04-30T00:00:00Z',
              legalHold: false,
              legalHoldReason: null,
              isImmutable: false,
              immutableUntil: null,
              immutabilityEnforcement: null,
              requestedImmutabilityEnforcement: null,
              immutabilityFallbackReason: null,
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/browse' && method === 'GET') {
        return makeJsonResponse({
          data: [{ name: 'Documents', path: '/Documents', type: 'directory' }],
          nextCursor: null,
        });
      }

      if (url === '/backup/snapshots/snap-1/browse?dir=%2FDocuments' && method === 'GET') {
        return makeJsonResponse({
          data: [{ name: 'report.txt', path: '/Documents/report.txt', type: 'file', sizeBytes: 1234 }],
          nextCursor: null,
        });
      }

      if (url === '/backup/snapshots/snap-1/legal-hold' && method === 'POST') {
        return makeJsonResponse({
          id: 'snap-1',
          label: 'Nightly Snapshot',
          createdAt: '2026-03-31T00:00:00Z',
          sizeBytes: 1048576,
          fileCount: 5,
          location: 'snapshots/provider-snap-1',
          expiresAt: '2026-04-30T00:00:00Z',
          legalHold: true,
          legalHoldReason: 'Litigation',
          isImmutable: false,
          immutableUntil: null,
          immutabilityEnforcement: null,
          requestedImmutabilityEnforcement: null,
          immutabilityFallbackReason: null,
        });
      }

      return makeJsonResponse({}, false, 404);
    });
  });

  it('renders snapshot protection details for the selected snapshot', async () => {
    render(<SnapshotBrowser />);

    await screen.findByText(/Protection Controls/i);
    expect(screen.getByText(/Protection Controls/i)).toBeTruthy();
    expect(screen.getByText(/Snapshot Details/i)).toBeTruthy();
    expect(screen.getByText(/Use the restore workflow to recover or export files from this snapshot/i)).toBeTruthy();
  });

  it('formats file size and modified time in the file table instead of raw bytes / ISO strings (#9626)', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/backup/snapshots/snap-1/browse?dir=%2FDocuments') {
        return makeJsonResponse({
          data: [{ name: 'big.bin', path: '/Documents/big.bin', type: 'file', sizeBytes: 4823117, modifiedAt: '2026-10-21T01:12:44.000Z' }],
          nextCursor: null,
        });
      }
      return base(input, init);
    });
    render(<SnapshotBrowser />);
    fireEvent.click(await screen.findByText('Documents'));
    const row = (await screen.findByText('big.bin')).closest('tr')!;
    expect(row.textContent).toContain('4.60 MB');
    expect(row.textContent).not.toContain('4823117 B');
    expect(row.textContent).not.toContain('2026-10-21T01:12:44.000Z');
  });

  it('shows integrity status in the snapshot picker and the details card (#9626)', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/backup/snapshots') {
        const res = await base(input, init);
        const payload = await res.json();
        return makeJsonResponse({ data: payload.data.map((row: object) => ({ ...row, integrityStatus: 'unattested' })) });
      }
      return base(input, init);
    });
    render(<SnapshotBrowser />);
    expect(await screen.findByRole('option', { name: /Nightly Snapshot.*Not verified/ })).toBeTruthy();
    expect((await screen.findByTestId('snapshot-integrity-badge')).textContent).toBe('Not verified');
  });

  it('loads only the root level up front and fetches a directory when it is selected (#8230)', async () => {
    render(<SnapshotBrowser />);

    await screen.findByText('Documents');
    const browseCalls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/browse'));
    expect(browseCalls()).toEqual(['/backup/snapshots/snap-1/browse']);
    expect(screen.queryByText('report.txt')).toBeNull();

    fireEvent.click(screen.getByText('Documents'));

    await screen.findByText('report.txt');
    expect(browseCalls()).toEqual([
      '/backup/snapshots/snap-1/browse',
      '/backup/snapshots/snap-1/browse?dir=%2FDocuments',
    ]);
  });

  it('retries a directory whose first load failed when it is selected again (#8230)', async () => {
    const base = fetchMock.getMockImplementation()!;
    let failures = 1;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/backup/snapshots/snap-1/browse?dir=%2FDocuments' && failures-- > 0) {
        return makeJsonResponse({ error: 'boom' }, false, 500);
      }
      return base(input, init);
    });

    render(<SnapshotBrowser />);
    fireEvent.click(await screen.findByText('Documents'));
    await screen.findByText(/Failed to browse snapshot/i);
    expect(screen.queryByText('report.txt')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    await screen.findByText('report.txt');
  });

  it('points the restore-workflow copy at the Restore tab, carrying the active snapshot (#6349, #6456)', async () => {
    render(<SnapshotBrowser />);

    await screen.findByText(/Protection Controls/i);
    const link = screen.getByTestId('snapshot-browser-restore-link');
    expect(link.tagName).toBe('A');
    // No files are checked off, but the snapshot currently being browsed is
    // still carried across (#6456) so the wizard opens on the right snapshot.
    expect(link.getAttribute('href')).toBe('#restore?snapshot=snap-1');
  });

  it('carries the selected snapshot id + checked files into the restore-workflow link (#6456)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/snapshots' && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Nightly Snapshot',
              createdAt: '2026-03-31T00:00:00Z',
              sizeBytes: 1048576,
              fileCount: 5,
              location: 'snapshots/provider-snap-1',
              expiresAt: '2026-04-30T00:00:00Z',
              legalHold: false,
              legalHoldReason: null,
              isImmutable: false,
              immutableUntil: null,
              immutabilityEnforcement: null,
              requestedImmutabilityEnforcement: null,
              immutabilityFallbackReason: null,
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/browse' && method === 'GET') {
        return makeJsonResponse({
          data: [
            { name: 'report.txt', path: '/report.txt', type: 'file', sizeBytes: 1234 },
          ],
        });
      }

      return makeJsonResponse({}, false, 404);
    });

    render(<SnapshotBrowser />);

    await screen.findByText('report.txt');
    // `findByText` resolves as soon as the browse-load commit reaches the DOM,
    // but that same commit also schedules SnapshotBrowser's selection-reset
    // effect (keyed on the newly-loaded tree id — see the comment above
    // `restoreLinkSnapshotId` in SnapshotBrowser.tsx). That effect is a
    // passive effect and isn't guaranteed to have run yet: under CI load it
    // can still be pending here, and if it fires *after* the click below it
    // clobbers the selection an instant after it was set. Flushing a
    // macrotask first lets that effect settle before we interact, so the
    // click always lands after the reset instead of racing it. Confirmed as
    // the real failure mode from CI (run 36269173200, attempt 1): the
    // captured href was `#restore?snapshot=snap-1` with no `paths=` at all —
    // the click never stuck.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.click(screen.getByLabelText('Select report.txt'));

    const link = screen.getByTestId('snapshot-browser-restore-link');
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('#restore?');
    expect(href).toContain('snapshot=snap-1');
    expect(href).toContain('paths=');
    expect(decodeURIComponent(href)).toContain('/report.txt');
  });

  describe('folder selection (#9628)', () => {
    const arrangeFolderTree = (fileCount: number) => {
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        const method = (init as RequestInit | undefined)?.method ?? 'GET';
        if (url === '/backup/snapshots' && method === 'GET') {
          return makeJsonResponse({
            data: [{ id: 'snap-1', label: 'Nightly Snapshot', createdAt: '2026-03-31T00:00:00Z', sizeBytes: 1, fileCount: 5 }],
          });
        }
        if (url === '/backup/snapshots/snap-1/browse' && method === 'GET') {
          return makeJsonResponse({
            data: [
              { name: 'Finance', path: '/Finance', type: 'directory', fileCount },
              { name: 'top.txt', path: '/top.txt', type: 'file', sizeBytes: 1 },
            ],
          });
        }
        return makeJsonResponse({}, false, 404);
      });
    };

    const settle = async () => {
      await screen.findByText('top.txt');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    it('lists subfolders with a checkbox and file count, and carries a checked folder into the restore link', async () => {
      arrangeFolderTree(7);
      render(<SnapshotBrowser />);
      await settle();

      expect(screen.getByText('7 files')).toBeTruthy();
      fireEvent.click(screen.getByLabelText('Select folder Finance'));

      const href = screen.getByTestId('snapshot-browser-restore-link').getAttribute('href') ?? '';
      expect(decodeURIComponent(href)).toContain('/Finance');
      expect((screen.getByLabelText('Select folder Finance') as HTMLInputElement).checked).toBe(true);
    });

    it('asks before selecting a folder over 1,000 files and honours a refusal', async () => {
      arrangeFolderTree(2500);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<SnapshotBrowser />);
      await settle();

      fireEvent.click(screen.getByLabelText('Select folder Finance'));
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect((screen.getByLabelText('Select folder Finance') as HTMLInputElement).checked).toBe(false);
      confirmSpy.mockRestore();
    });

  });

  it('applies legal hold for the selected snapshot', async () => {
    render(<SnapshotBrowser />);

    await screen.findByText(/Protection Controls/i);
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: 'Litigation' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply legal hold/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/backup/snapshots/snap-1/legal-hold',
      expect.objectContaining({ method: 'POST' }),
    ));
    await screen.findByText(/Legal hold applied/i);
  });

  it('shows a fallback warning when provider immutability degrades to application protection', async () => {
    fetchMock.mockImplementationOnce(async () => makeJsonResponse({
      data: [
        {
          id: 'snap-1',
          label: 'Nightly Snapshot',
          createdAt: '2026-03-31T00:00:00Z',
          sizeBytes: 1048576,
          fileCount: 5,
          location: 'snapshots/provider-snap-1',
          expiresAt: '2026-04-30T00:00:00Z',
          legalHold: false,
          legalHoldReason: null,
          isImmutable: true,
          immutableUntil: '2026-04-30T00:00:00Z',
          immutabilityEnforcement: 'application',
          requestedImmutabilityEnforcement: 'provider',
          immutabilityFallbackReason: 'Bucket object lock no longer enabled',
        },
      ],
    }));

    render(<SnapshotBrowser />);

    expect(await screen.findByText(/Provider immutability was requested by policy/i)).toBeTruthy();
    expect(screen.getByText(/Bucket object lock no longer enabled/i)).toBeTruthy();
  });

  it('names the device in the snapshot picker and the details card', async () => {
    const base = {
      createdAt: '2026-03-31T00:00:00Z',
      sizeBytes: 1048576,
      fileCount: 5,
      location: null,
      expiresAt: null,
      legalHold: false,
      legalHoldReason: null,
      isImmutable: false,
      immutableUntil: null,
      immutabilityEnforcement: null,
      requestedImmutabilityEnforcement: null,
      immutabilityFallbackReason: null,
    };
    fetchMock.mockImplementationOnce(async () => makeJsonResponse({
      data: [
        { ...base, id: 'snap-1', label: 'Nightly', deviceName: 'Mac Mini' },
        { ...base, id: 'snap-2', label: 'Whole machine', backupType: 'system_image', deviceName: 'SRV01' },
      ],
    }));

    render(<SnapshotBrowser />);

    expect(await screen.findByRole('option', { name: 'Mac Mini — Nightly' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'SRV01 — Whole machine — System image' })).toBeTruthy();
    expect((await screen.findByTestId('snapshot-device-name')).textContent).toBe('Mac Mini');
  });

  it('labels the storage location in the details card', async () => {
    render(<SnapshotBrowser />);

    await screen.findByText(/Snapshot Details/i);
    const location = screen.getByTestId('snapshot-location');
    expect(location.textContent).toContain('Location:');
    expect(location.textContent).toContain('snapshots/provider-snap-1');
  });

  it('says the file index is unavailable (not "still processing") when the API reports manifestUnavailable', async () => {
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/backup/snapshots/snap-1/browse') {
        return makeJsonResponse({ snapshotId: 'snap-1', manifestUnavailable: true, data: [] });
      }
      return base(input, init);
    });

    render(<SnapshotBrowser />);

    expect(await screen.findByText(/file list isn't available right now/i)).toBeTruthy();
    expect(screen.queryByText(/may still be processing/i)).toBeNull();
  });

  describe('#11026 file list states', () => {
    const withBrowse = (browse: (url: string) => unknown) => {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith('/backup/snapshots/snap-1/browse') || url.endsWith('/file-index/rebuild')) {
          const body = browse(url);
          return body instanceof Response ? body : makeJsonResponse(body);
        }
        return base(input, init);
      });
    };
    const browseCalls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/browse'));

    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows building, polls, and on ready discards the cached empty answer and lists the folders', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      let ready = false;
      withBrowse(() => (ready
        ? { index: { state: 'ready' }, data: [{ name: 'C:', path: '/C:', type: 'directory', fileCount: 3 }], nextCursor: null }
        : { index: { state: 'building' }, manifestUnavailable: true, data: [], nextCursor: null }));

      render(<SnapshotBrowser />);
      expect((await screen.findByTestId('snapshot-index-building')).textContent).toMatch(/Preparing this snapshot's file list/);
      expect(screen.queryByText(/may still be processing/i)).toBeNull();
      expect(screen.queryByText(/isn't available/i)).toBeNull();

      ready = true;
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

      await waitFor(() => expect(screen.queryByTestId('snapshot-index-building')).toBeNull());
      expect((await screen.findAllByText('C:')).length).toBeGreaterThan(0);
      const calls = browseCalls();
      expect(calls).toContain('/backup/snapshots/snap-1/browse?limit=1');
      expect(calls.filter((u) => u === '/backup/snapshots/snap-1/browse').length).toBe(2);
    });

    it('an integrity failure says so and offers no retry', async () => {
      withBrowse(() => ({ index: { state: 'unavailable', failure: 'attestation_failed', retryable: false, deviceLocal: false }, data: [] }));
      render(<SnapshotBrowser />);
      expect((await screen.findByTestId('snapshot-index-unavailable')).textContent).toMatch(/failed its integrity check/);
      expect(screen.queryByTestId('snapshot-index-retry')).toBeNull();
    });

    it('a device-local snapshot says the list cannot be read from there, with no retry', async () => {
      withBrowse(() => ({ index: { state: 'unavailable', failure: 'manifest_missing', retryable: true, deviceLocal: true }, data: [] }));
      render(<SnapshotBrowser />);
      expect((await screen.findByTestId('snapshot-index-unavailable')).textContent).toMatch(/stored on the device/);
      expect(screen.queryByTestId('snapshot-index-retry')).toBeNull();
    });

    it('a retryable failure offers a retry that posts the rebuild and shows building', async () => {
      withBrowse((url) => (url.endsWith('/file-index/rebuild')
        ? makeJsonResponse({ index: { state: 'building' } }, true, 202)
        : { index: { state: 'unavailable', failure: 'provider_error', retryable: true, deviceLocal: false }, data: [] }));
      render(<SnapshotBrowser />);
      expect((await screen.findByTestId('snapshot-index-unavailable')).textContent).toMatch(/You can still restore the whole snapshot/);

      fireEvent.click(screen.getByTestId('snapshot-index-retry'));

      expect(await screen.findByTestId('snapshot-index-building')).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledWith('/backup/snapshots/snap-1/file-index/rebuild', { method: 'POST' });
    });

    it('a truly empty snapshot shows the existing empty message', async () => {
      withBrowse(() => ({ index: { state: 'ready' }, data: [], nextCursor: null }));
      render(<SnapshotBrowser />);
      expect(await screen.findByText(/may still be processing/i)).toBeTruthy();
      expect(screen.queryByTestId('snapshot-index-building')).toBeNull();
      expect(screen.queryByTestId('snapshot-index-unavailable')).toBeNull();
    });
  });

  describe('#11026 file search', () => {
    const searchUrls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/search'));
    const withSearch = (search: (url: string) => unknown | Promise<unknown>, browse?: (url: string) => unknown) => {
      const base = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes('/snap-1/search')) {
          const out = await search(url);
          return out instanceof Object && 'json' in (out as object) ? (out as Response) : makeJsonResponse(out);
        }
        if (browse && url.startsWith('/backup/snapshots/snap-1/browse')) {
          const out = browse(url);
          if (out) return out as Response;
        }
        return base(input, init);
      });
    };
    const hit = (name: string, path: string) => ({ name, path, type: 'file', sizeBytes: 5, modifiedAt: '2026-10-21T01:12:44.000Z' });
    const type = async (value: string) => {
      const input = await screen.findByTestId('snapshot-search-input');
      fireEvent.change(input, { target: { value } });
    };

    it('queries after the debounce and renders results with a one-file restore link', async () => {
      withSearch(() => ({ data: [hit('q3.xlsx', 'C:/finance/q3.xlsx')], nextCursor: null, index: { state: 'ready' } }));
      render(<SnapshotBrowser />);
      await type('q3');
      expect(searchUrls()).toEqual([]);
      const results = await screen.findByTestId('snapshot-search-results');
      expect(results.textContent).toContain('q3.xlsx');
      expect(results.textContent).toContain('C:/finance/q3.xlsx');
      expect(searchUrls()).toEqual(['/backup/snapshots/snap-1/search?q=q3']);
      const link = screen.getByTestId('snapshot-search-restore-link');
      expect(link.getAttribute('href')).toBe(`#restore?snapshot=snap-1&paths=${encodeURIComponent('C:/finance/q3.xlsx')}`);
    });

    it('shows a folder result, such as an empty folder (#11235), as a folder', async () => {
      withSearch(() => ({
        data: [{ name: 'Empty', path: '/C:/Data/Empty', type: 'directory' }, hit('empty.txt', 'C:/Data/empty.txt')],
        nextCursor: null,
        index: { state: 'ready' },
      }));
      render(<SnapshotBrowser />);
      await type('empty');
      await screen.findByTestId('snapshot-search-results');
      expect(screen.getAllByTestId('snapshot-search-hit-folder')).toHaveLength(1);
      expect(screen.getAllByTestId('snapshot-search-hit-file')).toHaveLength(1);
      const links = screen.getAllByTestId('snapshot-search-restore-link');
      expect(links[0]!.getAttribute('href')).toBe(`#restore?snapshot=snap-1&paths=${encodeURIComponent('/C:/Data/Empty')}`);
    });

    it('sends the input as typed (untrimmed) and does not query for a single character', async () => {
      withSearch(() => ({ data: [], nextCursor: null, index: { state: 'ready' } }));
      render(<SnapshotBrowser />);
      await type('a');
      await new Promise((r) => setTimeout(r, 450));
      expect(searchUrls()).toEqual([]);
      expect(screen.getByText('Type at least 2 characters')).toBeTruthy();
      await type(' ab ');
      await waitFor(() => expect(searchUrls()).toEqual(['/backup/snapshots/snap-1/search?q=%20ab%20']));
    });

    it('returns to the tree when the query is cleared', async () => {
      withSearch(() => ({ data: [hit('q3.xlsx', 'C:/q3.xlsx')], nextCursor: null, index: { state: 'ready' } }));
      render(<SnapshotBrowser />);
      await type('q3');
      await screen.findByTestId('snapshot-search-results');
      await type('');
      await waitFor(() => expect(screen.queryByTestId('snapshot-search-results')).toBeNull());
      expect(screen.getByTestId('snapshot-browser-restore-link')).toBeTruthy();
    });

    it('load more appends the next page using the cursor', async () => {
      withSearch((url) => (url.includes('cursor=')
        ? { data: [hit('b.txt', 'C:/b.txt')], nextCursor: null, index: { state: 'ready' } }
        : { data: [hit('a.txt', 'C:/a.txt')], nextCursor: 'cur 1', index: { state: 'ready' } }));
      render(<SnapshotBrowser />);
      await type('txt');
      fireEvent.click(await screen.findByTestId('snapshot-search-more'));
      await waitFor(() => expect(screen.getAllByTestId('snapshot-search-restore-link')).toHaveLength(2));
      expect(searchUrls()[1]).toBe('/backup/snapshots/snap-1/search?q=txt&cursor=cur%201');
      expect(screen.queryByTestId('snapshot-search-more')).toBeNull();
    });

    it('says no files match when the index is ready and nothing matched', async () => {
      withSearch(() => ({ data: [], nextCursor: null, index: { state: 'ready' } }));
      render(<SnapshotBrowser />);
      await type('zz');
      expect((await screen.findByTestId('snapshot-search-empty')).textContent).toBe('No files match');
    });

    it('shows a retryable timeout message when the search query times out', async () => {
      let calls = 0;
      withSearch(() => {
        calls += 1;
        return calls === 1
          ? makeJsonResponse({ code: 'index_query_timeout' }, false, 503)
          : { data: [hit('a.txt', 'C:/a.txt')], nextCursor: null, index: { state: 'ready' } };
      });
      render(<SnapshotBrowser />);
      await type('zz');
      expect((await screen.findByTestId('snapshot-search-timeout')).textContent).toContain('Searching took too long. Try again.');
      expect(screen.queryByTestId('snapshot-search-empty')).toBeNull();
      fireEvent.click(screen.getByTestId('snapshot-search-timeout-retry'));
      expect(await screen.findByTestId('snapshot-search-results')).toBeTruthy();
    });

    it('shows the tree timeout message, not a generic failure or empty folder, when browse times out', async () => {
      withSearch(() => ({}), () => makeJsonResponse({ code: 'index_query_timeout' }, false, 503));
      render(<SnapshotBrowser />);
      const notice = await screen.findByTestId('snapshot-browse-timeout');
      expect(notice.textContent).toContain('Listing this folder took too long. Try again.');
      expect(screen.queryByText('Failed to browse snapshot')).toBeNull();
      expect(screen.queryByText(/may still be processing/i)).toBeNull();
    });

    it('a stale response for an older query does not replace a newer one', async () => {
      let releaseOld!: () => void;
      const oldGate = new Promise<void>((r) => { releaseOld = r; });
      withSearch(async (url) => {
        if (url.endsWith('q=ab')) {
          await oldGate;
          return { data: [hit('old.txt', 'C:/old.txt')], nextCursor: null, index: { state: 'ready' } };
        }
        return { data: [hit('new.txt', 'C:/new.txt')], nextCursor: null, index: { state: 'ready' } };
      });
      render(<SnapshotBrowser />);
      await type('ab');
      await waitFor(() => expect(searchUrls()).toHaveLength(1));
      await type('abc');
      await screen.findByText('new.txt');
      await act(async () => { releaseOld(); await Promise.resolve(); });
      expect(screen.getByText('new.txt')).toBeTruthy();
      expect(screen.queryByText('old.txt')).toBeNull();
    });

    it('shows the index state instead of "No files match" while the index is building', async () => {
      withSearch(() => ({ data: [], nextCursor: null, index: { state: 'building' } }));
      render(<SnapshotBrowser />);
      await type('zz');
      expect((await screen.findAllByTestId('snapshot-index-building')).length).toBeGreaterThan(0);
      expect(screen.queryByTestId('snapshot-search-empty')).toBeNull();
    });
  });

  it('gives the snapshot picker and the immutability select accessible names', async () => {
    render(<SnapshotBrowser />);

    await screen.findByText(/Protection Controls/i);
    expect(screen.getByRole('combobox', { name: 'Snapshot' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Immutability enforcement' })).toBeTruthy();
  });

  it('badges a system_image snapshot with its backup type', async () => {
    fetchMock.mockImplementationOnce(async () => makeJsonResponse({
      data: [
        {
          id: 'snap-1',
          label: 'Nightly Snapshot',
          createdAt: '2026-03-31T00:00:00Z',
          backupType: 'system_image',
          sizeBytes: 1048576,
          fileCount: 13,
          location: 'snapshots/provider-snap-1',
          expiresAt: '2026-04-30T00:00:00Z',
          legalHold: false,
          legalHoldReason: null,
          isImmutable: false,
          immutableUntil: null,
          immutabilityEnforcement: null,
          requestedImmutabilityEnforcement: null,
          immutabilityFallbackReason: null,
        },
      ],
    }));

    render(<SnapshotBrowser />);

    expect(await screen.findByText(/System image/i)).toBeTruthy();
  });

  it('shows the bare-metal verdict badge with reasons for a not-restorable snapshot', async () => {
    fetchMock.mockImplementationOnce(async () => makeJsonResponse({
      data: [
        {
          id: 'snap-1',
          label: 'Whole machine',
          createdAt: '2026-04-01T00:00:00Z',
          backupType: 'system_image',
          sizeBytes: 5000000000,
          fileCount: 120000,
          location: 'snapshots/provider-snap-1',
          expiresAt: null,
          legalHold: false,
          legalHoldReason: null,
          isImmutable: false,
          immutableUntil: null,
          immutabilityEnforcement: null,
          requestedImmutabilityEnforcement: null,
          immutabilityFallbackReason: null,
          bareMetalRestorable: false,
          bareMetalReasons: ['LVM volumes are not supported'],
        },
      ],
    }));

    render(<SnapshotBrowser />);

    const badge = await screen.findByTestId('snapshot-bare-metal-no');
    expect(badge).toHaveAttribute('title', 'LVM volumes are not supported');
    expect(screen.queryByTestId('snapshot-bare-metal-ok')).toBeNull();
  });

  it('shows the bare-metal restorable badge for a restorable snapshot', async () => {
    fetchMock.mockImplementationOnce(async () => makeJsonResponse({
      data: [
        {
          id: 'snap-1',
          label: 'Whole machine',
          createdAt: '2026-04-01T00:00:00Z',
          backupType: 'system_image',
          sizeBytes: 5000000000,
          fileCount: 120000,
          location: 'snapshots/provider-snap-1',
          expiresAt: null,
          legalHold: false,
          legalHoldReason: null,
          isImmutable: false,
          immutableUntil: null,
          immutabilityEnforcement: null,
          requestedImmutabilityEnforcement: null,
          immutabilityFallbackReason: null,
          bareMetalRestorable: true,
          bareMetalReasons: [],
        },
      ],
    }));

    render(<SnapshotBrowser />);

    expect(await screen.findByTestId('snapshot-bare-metal-ok')).toBeTruthy();
    expect(screen.queryByTestId('snapshot-bare-metal-no')).toBeNull();
  });
});
