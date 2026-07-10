import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OneDriveHelperTab from './OneDriveHelperTab';
import type { FeatureLink } from './types';
import * as onedriveApi from '../../../lib/api/onedrive';
import type { OneDriveLibrary } from '../../../lib/api/onedrive';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

// The add-library flow now runs through OneDriveLibraryPicker, which calls the
// onedrive api module. Mock it so the tab tests drive the REAL picker.
vi.mock('../../../lib/api/onedrive', () => ({
  fetchM365ConnectionStatus: vi.fn(),
  fetchOneDriveLibraries: vi.fn(),
}));

const mockedStatus = vi.mocked(onedriveApi.fetchM365ConnectionStatus);
const mockedLibraries = vi.mocked(onedriveApi.fetchOneDriveLibraries);

function graphLib(overrides: Partial<OneDriveLibrary> = {}): OneDriveLibrary {
  return {
    siteId: 'sp!composite',
    siteName: 'Finance Site',
    siteUrl: 'https://contoso.sharepoint.com/sites/finance',
    driveId: 'drive-1',
    listId: 'l1',
    libraryName: 'Finance',
    tenantId: 't1',
    webId: 'w1',
    spSiteId: 's1',
    autoMountValue: 'tenantId=t1&siteId=s1&webId=w1&listId=l1',
    ...overrides,
  };
}

const baseProps = {
  policyId: 'policy-1',
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

describe('OneDriveHelperTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'onedrive_helper',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  it('renders defaults when no link exists (KFM off hides folder checkboxes)', () => {
    render(<OneDriveHelperTab {...baseProps} existingLink={undefined} />);

    // Base toggles present.
    expect(screen.getByTestId('onedrive-toggle-silent')).toBeTruthy();
    expect(screen.getByTestId('onedrive-toggle-fod')).toBeTruthy();
    expect(screen.getByTestId('onedrive-toggle-kfm')).toBeTruthy();
    expect(screen.getByTestId('onedrive-toggle-restart')).toBeTruthy();

    // KFM is off by default -> folder checkboxes + tenant association hidden.
    expect(screen.queryByTestId('onedrive-kfm-folder-Desktop')).toBeNull();
    expect(screen.queryByTestId('onedrive-tenant-association')).toBeNull();

    // No libraries yet.
    expect(screen.queryByTestId('onedrive-lib-row-0')).toBeNull();
  });

  it('seeds state from existingLink.inlineSettings', () => {
    const existingLink: FeatureLink = {
      id: 'link-1',
      featureType: 'onedrive_helper',
      featurePolicyId: null,
      inlineSettings: {
        silentAccountConfig: true,
        filesOnDemand: true,
        kfmSilentOptIn: true,
        kfmFolders: ['Desktop', 'Documents'],
        kfmBlockOptOut: true,
        tenantAssociationId: 'tenant-guid-123',
        restartOnChange: false,
        libraries: [
          {
            libraryId: 'tenantId=t1&siteId=s1',
            displayName: 'Marketing Share',
            siteUrl: 'https://contoso.sharepoint.com/sites/marketing',
            targetingMode: 'everyone',
            hiveScope: 'hkcu',
            enabled: true,
          },
        ],
      },
    };

    render(<OneDriveHelperTab {...baseProps} existingLink={existingLink} />);

    // KFM on -> folder checkboxes + tenant association visible and seeded.
    const desktop = screen.getByTestId('onedrive-kfm-folder-Desktop') as HTMLInputElement;
    const pictures = screen.getByTestId('onedrive-kfm-folder-Pictures') as HTMLInputElement;
    expect(desktop.checked).toBe(true);
    expect(pictures.checked).toBe(false);
    expect((screen.getByTestId('onedrive-tenant-association') as HTMLInputElement).value).toBe('tenant-guid-123');

    // Library row seeded.
    expect(screen.getByTestId('onedrive-lib-row-0')).toBeTruthy();
    expect(screen.getByText('Marketing Share')).toBeTruthy();
  });

  it('Save posts the full allowlisted payload', async () => {
    render(<OneDriveHelperTab {...baseProps} existingLink={undefined} />);

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const [linkId, payload] = saveMock.mock.calls[0] as [
      string | null,
      { featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> },
    ];
    expect(linkId).toBeNull();
    expect(payload.featureType).toBe('onedrive_helper');
    expect(payload.featurePolicyId).toBeNull();
    expect(payload.inlineSettings).toEqual({
      silentAccountConfig: true,
      filesOnDemand: true,
      kfmSilentOptIn: false,
      kfmFolders: ['Desktop', 'Documents', 'Pictures'],
      kfmBlockOptOut: false,
      tenantAssociationId: null,
      restartOnChange: true,
      libraries: [],
    });
  });

  it('adding a library via the Graph picker then saving includes it with targetingMode everyone', async () => {
    mockedStatus.mockResolvedValue(true);
    mockedLibraries.mockResolvedValue({ libraries: [graphLib()], skippedSites: [] });

    render(<OneDriveHelperTab {...baseProps} existingLink={undefined} />);

    // Open the picker and pick a Graph library.
    fireEvent.click(screen.getByTestId('onedrive-add-library-btn'));
    await waitFor(() => expect(screen.getByTestId('onedrive-picker-add-drive-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('onedrive-picker-add-drive-1'));

    // Close the picker; the row is now on the tab.
    fireEvent.click(screen.getByTestId('onedrive-picker-close'));
    expect(screen.getByTestId('onedrive-lib-row-0')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const [, payload] = saveMock.mock.calls[0] as [
      string | null,
      { inlineSettings: { libraries: Array<Record<string, unknown>> } },
    ];
    expect(payload.inlineSettings.libraries).toHaveLength(1);
    expect(payload.inlineSettings.libraries[0]).toMatchObject({
      libraryId: 'tenantId=t1&siteId=s1&webId=w1&listId=l1',
      displayName: 'Finance',
      siteId: 's1', // spSiteId (bare GUID) flows through
      webId: 'w1',
      listId: 'l1',
      targetingMode: 'everyone',
      hiveScope: 'hkcu',
      enabled: true,
    });
  });

  it('picker manual fallback rejects an id that does not start with tenantId=', async () => {
    // Disconnected → picker surfaces the manual-paste fallback directly.
    mockedStatus.mockResolvedValue(false);

    render(<OneDriveHelperTab {...baseProps} existingLink={undefined} />);

    fireEvent.click(screen.getByTestId('onedrive-add-library-btn'));
    await waitFor(() => expect(screen.getByTestId('onedrive-picker-manual-id')).toBeTruthy());

    // Disconnected → libraries never fetched.
    expect(mockedLibraries).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('onedrive-picker-manual-id'), {
      target: { value: 'not-a-composite-id' },
    });
    fireEvent.change(screen.getByTestId('onedrive-picker-manual-name'), {
      target: { value: 'Bad' },
    });
    fireEvent.click(screen.getByTestId('onedrive-picker-manual-submit'));

    // Not added to the tab.
    expect(screen.queryByTestId('onedrive-lib-row-0')).toBeNull();
    expect(screen.getByText(/must start with/i)).toBeTruthy();
  });

  it('graph_group mode without group id or name disables Save and shows a hint', () => {
    const existingLink: FeatureLink = {
      id: 'link-1',
      featureType: 'onedrive_helper',
      featurePolicyId: null,
      inlineSettings: {
        libraries: [
          {
            libraryId: 'tenantId=t1&siteId=s1',
            displayName: 'Marketing',
            targetingMode: 'everyone',
            hiveScope: 'hkcu',
            enabled: true,
          },
        ],
      },
    };

    render(<OneDriveHelperTab {...baseProps} existingLink={existingLink} />);

    fireEvent.change(screen.getByTestId('onedrive-lib-targeting-0'), {
      target: { value: 'graph_group' },
    });

    const save = screen.getByRole('button', { name: /^Save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/requires a group/i)).toBeTruthy();
  });

  it('inherited (parentLink only) shows Override and no direct Save', () => {
    const parentLink: FeatureLink = {
      id: 'parent-link',
      featureType: 'onedrive_helper',
      featurePolicyId: null,
      inlineSettings: { silentAccountConfig: false },
    };

    render(
      <OneDriveHelperTab {...baseProps} existingLink={undefined} parentLink={parentLink} />,
    );

    expect(screen.getByRole('button', { name: /Override/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Save$/i })).toBeNull();
  });
});
