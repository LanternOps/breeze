import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BackupTab from './BackupTab';
import { fetchWithAuth } from '../../../stores/auth';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const baseConfig = {
  id: 'config-1',
  name: 'Primary S3',
  provider: 's3',
  enabled: true,
  details: {
    bucket: 'backups',
    region: 'us-east-1',
  },
  providerCapabilities: null,
  createdAt: '2026-03-31T00:00:00Z',
  updatedAt: '2026-03-31T00:00:00Z',
};

const baseLink = {
  id: 'link-1',
  featureType: 'backup' as const,
  featurePolicyId: 'config-1',
  inlineSettings: {
    backupMode: 'file',
    targets: { paths: ['C:/Data'], excludes: [] },
    schedule: {
      frequency: 'daily',
      time: '03:00',
    },
    retention: {
      preset: 'standard',
      retentionDays: 30,
      maxVersions: 5,
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: 12,
      keepYearly: 3,
      weeklyDay: 0,
    },
    paths: ['C:/Data'],
  },
};

describe('BackupTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'backup',
      featurePolicyId: 'config-1',
      inlineSettings: {},
    });
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/configs' && method === 'GET') {
        return makeJsonResponse({
          data: [baseConfig],
        });
      }

      if (url === '/backup/profiles' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }

      if (url === '/backup/configs/config-1/test' && method === 'POST') {
        return makeJsonResponse({
          id: 'config-1',
          provider: 's3',
          status: 'success',
          checkedAt: '2026-03-31T01:00:00Z',
          providerCapabilities: {
            objectLock: {
              supported: true,
              checkedAt: '2026-03-31T01:00:00Z',
              error: null,
            },
          },
          config: {
            ...baseConfig,
            providerCapabilities: {
              objectLock: {
                supported: true,
                checkedAt: '2026-03-31T01:00:00Z',
                error: null,
              },
            },
          },
        });
      }

      return makeJsonResponse({}, false, 404);
    });
  });

  it('disables provider immutability when capability is unknown', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={baseLink}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText(/Primary S3/i);
    const providerOption = screen.getByRole('option', { name: /Provider-enforced WORM/i }) as HTMLOptionElement;
    expect(providerOption.disabled).toBe(true);
  });

  it('enables provider immutability after a successful capability retest', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={baseLink}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText(/Primary S3/i);
    fireEvent.click(screen.getByRole('button', { name: /^Test$/i }));

    await screen.findByText(/object lock support was verified/i);
    const providerOption = screen.getByRole('option', { name: /Provider-enforced WORM/i }) as HTMLOptionElement;
    expect(providerOption.disabled).toBe(false);
  });

  it('blocks raw save for invalid provider mode and allows downgrade save', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={{
          ...baseLink,
          inlineSettings: {
            ...baseLink.inlineSettings,
            retention: {
              ...((baseLink.inlineSettings?.retention as Record<string, unknown>) ?? {}),
              immutabilityMode: 'provider',
              immutableDays: 30,
            },
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText(/Provider immutability is configured/i);
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(saveMock).not.toHaveBeenCalled();
    expect(await screen.findByText(/Provider immutability cannot be saved until object lock support is verified/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Save with application protection/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({
        inlineSettings: expect.objectContaining({
          retention: expect.objectContaining({
            immutabilityMode: 'application',
          }),
        }),
      }),
    );
  });

  it('blocks file-mode save with no backup paths and shows a friendly error', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={{
          ...baseLink,
          inlineSettings: {
            ...baseLink.inlineSettings,
            targets: { paths: [], excludes: [] },
            paths: [],
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText('Primary S3');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(await screen.findByText(/Add at least one backup path/i)).toBeTruthy();
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('flushes a typed-but-not-added backup path on save', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={{
          ...baseLink,
          inlineSettings: {
            ...baseLink.inlineSettings,
            targets: { paths: [], excludes: [] },
            paths: [],
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText('Primary S3');
    const pathInput = screen.getByPlaceholderText(/C:\\Users/i);
    fireEvent.change(pathInput, { target: { value: '/Users' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({
        inlineSettings: expect.objectContaining({
          paths: ['/Users'],
          targets: expect.objectContaining({ paths: ['/Users'] }),
        }),
      }),
    );
  });

  it('edits an existing storage config via PATCH with masked secrets preserved', async () => {
    const configWithRedactedSecrets = {
      ...baseConfig,
      details: {
        bucket: 'backups',
        region: '',
        endpoint: 's3.us-west-004.backblazeb2.com',
        accessKey: { redacted: true, hasSecret: true, masked: '********' },
        secretKey: { redacted: true, hasSecret: true, masked: '********' },
      },
    };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/backup/configs' && method === 'GET') {
        return makeJsonResponse({ data: [configWithRedactedSecrets] });
      }
      if (url === '/backup/configs/config-1' && method === 'PATCH') {
        return makeJsonResponse({
          ...configWithRedactedSecrets,
          details: { ...configWithRedactedSecrets.details, region: 'us-west-004' },
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(
      <BackupTab
        policyId="policy-1"
        existingLink={baseLink}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText('Primary S3');
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    expect(await screen.findByText(/Editing storage configuration/i)).toBeTruthy();
    // The picker grid must be swapped out while editing so selection and the
    // edit target cannot desync.
    expect(screen.queryByRole('radio', { name: 'Primary S3' })).toBeNull();

    const regionInput = screen.getByPlaceholderText(/us-east-1/i);
    fireEvent.change(regionInput, { target: { value: 'us-west-004' } });
    fireEvent.click(screen.getByRole('switch', { name: /Server-side encryption/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/backup/configs/config-1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/backup/configs/config-1' && (init as RequestInit)?.method === 'PATCH',
    );
    const patchBody = JSON.parse(String((patchCall?.[1] as RequestInit).body));
    expect(patchBody.encryption).toBe(true);
    expect(patchBody.details).toMatchObject({
      bucket: 'backups',
      region: 'us-west-004',
      endpoint: 's3.us-west-004.backblazeb2.com',
      accessKey: '********',
      secretKey: '********',
      // Enabling encryption without a stored algorithm defaults to SSE-S3 so
      // the API's assertBackupStorageEncryptionSupported accepts the config.
      serverSideEncryption: 'AES256',
    });
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
  });

  it('preserves stored SSE settings through an unrelated edit', async () => {
    const encryptedConfig = {
      ...baseConfig,
      encryption: { enabled: true, status: 'enforced', mode: 's3-sse-kms' },
      details: {
        bucket: 'backups',
        region: 'us-east-1',
        serverSideEncryption: 'aws:kms',
        kmsKeyId: 'key-1',
        accessKey: { redacted: true, hasSecret: true, masked: '********' },
        secretKey: { redacted: true, hasSecret: true, masked: '********' },
      },
    };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/backup/configs' && method === 'GET') {
        return makeJsonResponse({ data: [encryptedConfig] });
      }
      if (url === '/backup/configs/config-1' && method === 'PATCH') {
        return makeJsonResponse(encryptedConfig);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(
      <BackupTab
        policyId="policy-1"
        existingLink={baseLink}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText('Primary S3');
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    const nameInput = await screen.findByPlaceholderText(/Production S3 Backups/i);
    fireEvent.change(nameInput, { target: { value: 'Renamed S3' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/backup/configs/config-1',
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
    const patchCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url) === '/backup/configs/config-1' && (init as RequestInit)?.method === 'PATCH',
    );
    const patchBody = JSON.parse(String((patchCall?.[1] as RequestInit).body));
    // A rename must not strip SSE settings — the API's encryption re-check
    // rejects an encrypted config whose algorithm/key went missing.
    expect(patchBody.details).toMatchObject({
      serverSideEncryption: 'aws:kms',
      kmsKeyId: 'key-1',
    });
    expect(patchBody.encryption).toBe(true);
  });

  it('blocks s3 create when region is empty and not derivable from the endpoint', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/backup/configs' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(
      <BackupTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    // With no configs the tab drops into create mode automatically
    const nameInput = await screen.findByPlaceholderText(/Production S3 Backups/i);
    fireEvent.change(nameInput, { target: { value: 'My B2' } });
    fireEvent.change(screen.getByPlaceholderText(/my-backup-bucket/i), {
      target: { value: 'bucket' },
    });
    // Satisfy the backup-path requirement so the region check is what fires
    fireEvent.change(screen.getByPlaceholderText(/C:\\Users/i), {
      target: { value: '/data' },
    });
    const regionInput = screen.getByPlaceholderText(/us-east-1/i);
    fireEvent.change(regionInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(await screen.findByText(/S3 region is required/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/backup/configs',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('auto-fills the region from an S3-compatible endpoint', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/backup/configs' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(
      <BackupTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByPlaceholderText(/Production S3 Backups/i);
    const endpointInput = screen.getByPlaceholderText(/backblazeb2/i);
    fireEvent.change(endpointInput, {
      target: { value: 's3.us-west-004.backblazeb2.com' },
    });

    const regionInput = screen.getByPlaceholderText(/us-east-1/i) as HTMLInputElement;
    expect(regionInput.value).toBe('us-west-004');
  });

  it('seeds paths and exclusions from an OS preset and saves them', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={{
          ...baseLink,
          inlineSettings: {
            ...baseLink.inlineSettings,
            targets: { paths: [], excludes: [] },
            paths: [],
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText('Primary S3');
    fireEvent.click(screen.getByRole('button', { name: /Windows user data/i }));

    // Preset lands as ordinary editable chips
    expect(screen.getByText('C:\\Users')).toBeTruthy();
    expect(screen.getByText('$RECYCLE.BIN/**')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({
        inlineSettings: expect.objectContaining({
          paths: ['C:\\Users'],
          targets: expect.objectContaining({
            paths: ['C:\\Users'],
            excludes: expect.arrayContaining([
              '**/AppData/Local/Temp/**',
              '$RECYCLE.BIN/**',
            ]),
          }),
        }),
      }),
    );
  });

  it('asks before discarding type-specific targets on a backup type switch', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={{
          ...baseLink,
          inlineSettings: {
            ...baseLink.inlineSettings,
            backupMode: 'hyperv',
            targets: { consistencyType: 'crash' },
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText('Primary S3');
    expect(screen.getByText(/Consistency Type/i)).toBeTruthy();

    // Keep current cancels the switch
    fireEvent.click(screen.getByRole('button', { name: /File Backup/i }));
    expect(await screen.findByText(/Switch backup type\?/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Keep current/i }));
    expect(screen.queryByText(/Switch backup type\?/i)).toBeNull();
    expect(screen.getByText(/Consistency Type/i)).toBeTruthy();

    // Switch and clear applies it
    fireEvent.click(screen.getByRole('button', { name: /File Backup/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Switch and clear/i }));
    expect(screen.queryByText(/Consistency Type/i)).toBeNull();
    expect(screen.getByText('Exclusion Patterns')).toBeTruthy();
  });

  it('hides GFS and backup window behind the advanced disclosure by default', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={baseLink}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText('Primary S3');
    expect(screen.queryByText('GFS Retention')).toBeNull();
    expect(screen.queryByText('Backup Window')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: /Advanced retention & timing/i }),
    );
    expect(screen.getByText('GFS Retention')).toBeTruthy();
    expect(screen.getByText('Backup Window')).toBeTruthy();
  });

  it('auto-opens the advanced disclosure when saved settings use it', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={{
          ...baseLink,
          inlineSettings: {
            ...baseLink.inlineSettings,
            schedule: {
              ...(baseLink.inlineSettings.schedule as Record<string, unknown>),
              windowStart: '01:00',
              windowEnd: '05:00',
            },
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText('Primary S3');
    expect(screen.getByText('Backup Window')).toBeTruthy();
  });

  it('profile mode: save links the profile and sends schedule/retention/destination inline', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/backup/configs' && method === 'GET') {
        return makeJsonResponse({ data: [baseConfig] });
      }
      if (url === '/backup/profiles' && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'prof-1',
              name: 'Server',
              partnerId: null,
              selections: { file: { enabled: true, paths: ['C:\\Users'] } },
              isActive: true,
            },
          ],
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(
      <BackupTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    // Profiles exist and there's no link yet → profile mode is the default
    const profileCard = await screen.findByRole('radio', { name: 'Server' });
    fireEvent.click(profileCard);
    fireEvent.click(screen.getByRole('radio', { name: 'Primary S3' }));
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const [linkId, payload] = saveMock.mock.calls[0]!;
    expect(linkId).toBeNull();
    expect(payload.featurePolicyId).toBe('prof-1');
    expect(payload.inlineSettings.destinationConfigId).toBe('config-1');
    expect(payload.inlineSettings.schedule).toBeTruthy();
    expect(payload.inlineSettings.retention).toBeTruthy();
    // "What to protect" lives on the profile, not the link
    expect(payload.inlineSettings.backupMode).toBeUndefined();
    expect(payload.inlineSettings.targets).toBeUndefined();
  });

  it('custom mode: save clears featurePolicyId and carries the destination inline', async () => {
    render(
      <BackupTab
        policyId="policy-1"
        existingLink={baseLink}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    await screen.findByText('Primary S3');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock).toHaveBeenCalledWith(
      'link-1',
      expect.objectContaining({
        // Legacy featurePolicyId-as-destination is migrated on save
        featurePolicyId: null,
        inlineSettings: expect.objectContaining({
          destinationConfigId: 'config-1',
          backupMode: 'file',
        }),
      }),
    );
  });
  // A failed /backup/profiles fetch used to render as "no profiles yet". A user
  // looking at that false-empty picker can reasonably switch to "custom" and
  // save — permanently converting a profile link on the basis of data that
  // never arrived. Surface the failure and refuse the save instead.
  it('profile fetch failure: shows an error instead of the empty picker, and blocks converting an existing profile link', async () => {
    const profileLink = {
      id: 'link-1',
      featureType: 'backup',
      featurePolicyId: 'prof-1',
      inlineSettings: { backupProfileId: 'prof-1', schedule: { frequency: 'daily', time: '02:00' } },
    };
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/backup/configs' && method === 'GET') {
        return makeJsonResponse({ data: [baseConfig] });
      }
      // The profile list is down.
      if (url === '/backup/profiles' && method === 'GET') {
        return makeJsonResponse({ error: 'boom' }, false, 500);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(
      <BackupTab
        policyId="policy-1"
        existingLink={profileLink as never}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    // The picker must NOT claim the org has no profiles.
    expect(await screen.findByTestId('backup-profiles-load-error')).toBeTruthy();
    expect(screen.queryByText(/No backup profiles yet/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    // The link is never rewritten from a list we failed to load.
    await waitFor(() => expect(screen.getByTestId('backup-profiles-load-error')).toBeTruthy());
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('destination fetch failure: shows an error instead of the create-first-destination form', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      // The destination list is down — the org may well have destinations.
      if (url === '/backup/configs' && method === 'GET') {
        return makeJsonResponse({ error: 'boom' }, false, 500);
      }
      if (url === '/backup/profiles' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(
      <BackupTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    expect(await screen.findByTestId('backup-destinations-load-error')).toBeTruthy();
    // The create form must not auto-open over a load failure.
    expect(screen.queryByText(/Editing storage configuration/i)).toBeNull();
  });

  it('destination 403: shows a permissions panel with NO retry, not the load-error banner (#2429)', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';
      if (url === '/backup/configs' && method === 'GET') {
        return makeJsonResponse({ error: 'forbidden' }, false, 403);
      }
      if (url === '/backup/profiles' && method === 'GET') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(
      <BackupTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    // A 403 is terminal for this user: the retryable banner (and its Retry
    // button, which could only 403 again) must not be what they see.
    expect(await screen.findByTestId('backup-destinations-denied')).toBeTruthy();
    expect(screen.queryByTestId('backup-destinations-load-error')).toBeNull();
    // Still never the create-first-destination form.
    expect(screen.queryByText(/Editing storage configuration/i)).toBeNull();
  });
});
