import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OneDriveLibraryPicker from './OneDriveLibraryPicker';
import * as api from '../../../lib/api/onedrive';
import type { OneDriveLibrary } from '../../../lib/api/onedrive';

vi.mock('../../../lib/api/onedrive', () => ({
  fetchM365ConnectionStatus: vi.fn(),
  fetchOneDriveLibraries: vi.fn(),
}));

const mockedStatus = vi.mocked(api.fetchM365ConnectionStatus);
const mockedLibraries = vi.mocked(api.fetchOneDriveLibraries);

function lib(overrides: Partial<OneDriveLibrary> = {}): OneDriveLibrary {
  return {
    siteId: 'sp!site-guid',
    siteName: 'Marketing',
    siteUrl: 'https://contoso.sharepoint.com/sites/marketing',
    driveId: 'drive-1',
    listId: 'list-1',
    libraryName: 'Documents',
    tenantId: 'tenant-1',
    webId: 'web-1',
    spSiteId: 'site-guid-bare',
    autoMountValue: 'tenantId=tenant-1&siteId=site-guid-bare&webId=web-1&listId=list-1',
    ...overrides,
  };
}

describe('OneDriveLibraryPicker', () => {
  const onAdd = vi.fn();
  const onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no connection → shows manual fallback and does NOT fetch libraries', async () => {
    mockedStatus.mockResolvedValue(false);

    render(<OneDriveLibraryPicker onAdd={onAdd} onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId('onedrive-picker-no-connection')).toBeTruthy());

    // Manual fallback visible.
    expect(screen.getByTestId('onedrive-picker-manual-id')).toBeTruthy();
    expect(screen.getByTestId('onedrive-picker-manual-name')).toBeTruthy();

    // Libraries never fetched when disconnected.
    expect(mockedLibraries).not.toHaveBeenCalled();
  });

  it('connection probe 404s (M365 flag disabled server-side) → disconnected state, not error, libraries never fetched', async () => {
    // fetchM365ConnectionStatus never throws for a non-ok response (see onedrive.ts) —
    // a flag-disabled 404 resolves to `false` here, same as any other disconnected probe.
    mockedStatus.mockResolvedValue(false);

    render(<OneDriveLibraryPicker onAdd={onAdd} onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId('onedrive-picker-no-connection')).toBeTruthy());

    // Manual-paste fallback is reachable — this is the whole point of the fix.
    expect(screen.getByTestId('onedrive-picker-manual-id')).toBeTruthy();
    expect(screen.getByTestId('onedrive-picker-manual-name')).toBeTruthy();

    // Must NOT land in the error state.
    expect(screen.queryByTestId('onedrive-picker-error')).toBeNull();
    expect(screen.queryByTestId('onedrive-picker-retry')).toBeNull();

    // Libraries never fetched when disconnected.
    expect(mockedLibraries).not.toHaveBeenCalled();
  });

  it('manual fallback rejects an id that does not start with tenantId=', async () => {
    mockedStatus.mockResolvedValue(false);

    render(<OneDriveLibraryPicker onAdd={onAdd} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('onedrive-picker-manual-id')).toBeTruthy());

    fireEvent.change(screen.getByTestId('onedrive-picker-manual-id'), { target: { value: 'nope' } });
    fireEvent.change(screen.getByTestId('onedrive-picker-manual-name'), { target: { value: 'Bad' } });
    fireEvent.click(screen.getByTestId('onedrive-picker-manual-submit'));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByText(/must start with/i)).toBeTruthy();
  });

  it('manual fallback adds a valid composite id via onAdd', async () => {
    mockedStatus.mockResolvedValue(false);

    render(<OneDriveLibraryPicker onAdd={onAdd} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('onedrive-picker-manual-id')).toBeTruthy());

    fireEvent.change(screen.getByTestId('onedrive-picker-manual-id'), {
      target: { value: 'tenantId=t1&siteId=s1' },
    });
    fireEvent.change(screen.getByTestId('onedrive-picker-manual-name'), { target: { value: 'Finance' } });
    fireEvent.click(screen.getByTestId('onedrive-picker-manual-submit'));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ libraryId: 'tenantId=t1&siteId=s1', displayName: 'Finance' }),
    );
  });

  it('connected → renders libraries grouped by site; Add maps autoMountValue/spSiteId', async () => {
    mockedStatus.mockResolvedValue(true);
    mockedLibraries.mockResolvedValue({
      libraries: [
        lib({ driveId: 'drive-1', siteName: 'Marketing', libraryName: 'Documents' }),
        lib({ driveId: 'drive-2', siteName: 'Finance', libraryName: 'Reports', spSiteId: 'finance-guid' }),
      ],
      skippedSites: [],
    });

    render(<OneDriveLibraryPicker onAdd={onAdd} onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId('onedrive-picker-add-drive-1')).toBeTruthy());

    // Grouped-by-site headings.
    expect(screen.getByText('Marketing')).toBeTruthy();
    expect(screen.getByText('Finance')).toBeTruthy();

    fireEvent.click(screen.getByTestId('onedrive-picker-add-drive-1'));

    expect(onAdd).toHaveBeenCalledTimes(1);
    const arg = onAdd.mock.calls[0][0];
    expect(arg.libraryId).toBe('tenantId=tenant-1&siteId=site-guid-bare&webId=web-1&listId=list-1');
    expect(arg.siteId).toBe('site-guid-bare'); // spSiteId (bare GUID), NOT siteId
    expect(arg.displayName).toBe('Documents');
    expect(arg.webId).toBe('web-1');
    expect(arg.listId).toBe('list-1');
  });

  it('connected → search filters the library rows', async () => {
    mockedStatus.mockResolvedValue(true);
    mockedLibraries.mockResolvedValue({
      libraries: [
        lib({ driveId: 'drive-1', siteName: 'Marketing', libraryName: 'Documents' }),
        lib({ driveId: 'drive-2', siteName: 'Finance', libraryName: 'Reports' }),
      ],
      skippedSites: [],
    });

    render(<OneDriveLibraryPicker onAdd={onAdd} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('onedrive-picker-add-drive-1')).toBeTruthy());

    fireEvent.change(screen.getByTestId('onedrive-picker-search'), { target: { value: 'report' } });

    expect(screen.queryByTestId('onedrive-picker-add-drive-1')).toBeNull();
    expect(screen.getByTestId('onedrive-picker-add-drive-2')).toBeTruthy();
  });

  it('connected → row with empty autoMountValue is disabled', async () => {
    mockedStatus.mockResolvedValue(true);
    mockedLibraries.mockResolvedValue({
      libraries: [lib({ driveId: 'drive-x', autoMountValue: '' })],
      skippedSites: [],
    });

    render(<OneDriveLibraryPicker onAdd={onAdd} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('onedrive-picker-add-drive-x')).toBeTruthy());

    const btn = screen.getByTestId('onedrive-picker-add-drive-x') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('connected → skippedSites renders a warning line', async () => {
    mockedStatus.mockResolvedValue(true);
    mockedLibraries.mockResolvedValue({
      libraries: [lib()],
      skippedSites: [
        { siteId: 'a', code: 'forbidden' },
        { siteId: 'b', code: 'error' },
      ],
    });

    render(<OneDriveLibraryPicker onAdd={onAdd} onClose={onClose} />);
    await waitFor(() => expect(screen.getByTestId('onedrive-picker-skipped-warning')).toBeTruthy());

    expect(screen.getByText(/2 sites could not be read/i)).toBeTruthy();
  });

  it('error while fetching libraries → error + retry re-fetches', async () => {
    mockedStatus.mockResolvedValue(true);
    mockedLibraries.mockRejectedValueOnce(new Error('Graph exploded')).mockResolvedValueOnce({
      libraries: [lib()],
      skippedSites: [],
    });

    render(<OneDriveLibraryPicker onAdd={onAdd} onClose={onClose} />);

    await waitFor(() => expect(screen.getByTestId('onedrive-picker-error')).toBeTruthy());
    expect(screen.getByText(/Graph exploded/i)).toBeTruthy();

    fireEvent.click(screen.getByTestId('onedrive-picker-retry'));

    await waitFor(() => expect(screen.getByTestId('onedrive-picker-add-drive-1')).toBeTruthy());
  });
});
