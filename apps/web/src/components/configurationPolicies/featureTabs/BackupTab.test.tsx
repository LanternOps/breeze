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

    await screen.findByText('Primary S3 (Amazon S3)');
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

    await screen.findByText('Primary S3 (Amazon S3)');
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

    await screen.findByText('Primary S3 (Amazon S3)');
    fireEvent.click(screen.getByRole('button', { name: /^Edit$/i }));
    expect(await screen.findByText(/Editing storage configuration/i)).toBeTruthy();

    const regionInput = screen.getByPlaceholderText(/us-east-1/i);
    fireEvent.change(regionInput, { target: { value: 'us-west-004' } });
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
    expect(patchBody.details).toMatchObject({
      bucket: 'backups',
      region: 'us-west-004',
      endpoint: 's3.us-west-004.backblazeb2.com',
      accessKey: '********',
      secretKey: '********',
    });
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
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
});
