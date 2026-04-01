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
    targets: { paths: [], excludes: [] },
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
    paths: [],
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
});
