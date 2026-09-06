import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';

/**
 * Wiring coverage for the scheduled-restart badge (#3207 W5).
 *
 * `GET /devices/:id` returns `rebootScheduledAt`/`rebootDeadline`/
 * `rebootSource`/`rebootDeferralsUsed`/`rebootMaxDeferrals` correctly, but
 * DeviceDetailPage's API-response → Device transform is an explicit
 * whitelist (see the comment at DeviceDetailPage.tsx:108-112 about exactly
 * this failure mode for `possibleReplacementOfDeviceId`), so a dropped field
 * here silently kills RebootScheduledBadge with nothing else going red.
 */

const DEVICE_ID = '22222222-2222-2222-2222-222222222222';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: () => () => undefined }),
}));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setPageContext: () => undefined }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 404): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  // Every incidental panel fetch 404s; only the device-detail fetch below
  // matters, and the badge is required to render even when those 404.
  fetchWithAuthMock.mockResolvedValue(jsonResponse({}, false, 404));
});

describe('DeviceDetailPage — carries reboot-scheduled fields through its transform (#3207)', () => {
  it('renders the scheduled-restart badge from the API response fields', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (url === `/devices/${DEVICE_ID}`) {
        return Promise.resolve(
          jsonResponse({
            id: DEVICE_ID,
            hostname: 'WIN-PATCH-01',
            osType: 'windows',
            osVersion: '11',
            status: 'online',
            orgId: 'org-1',
            siteId: 'site-1',
            agentVersion: '1.0.0',
            tags: [],
            recentMetrics: [],
            rebootScheduledAt: '2099-01-01T00:00:00.000Z',
            rebootDeadline: '2099-01-02T00:00:00.000Z',
            rebootSource: 'patch_job',
            rebootDeferralsUsed: 1,
            rebootMaxDeferrals: 3,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, false, 404));
    });

    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId('device-reboot-scheduled')).toBeInTheDocument(),
    );
    // Badge presence alone is a vacuous assertion here: RebootScheduledBadge
    // renders from `rebootScheduledAt` alone, so a transform that dropped
    // `rebootDeadline`/`rebootDeferralsUsed`/`rebootMaxDeferrals` would still
    // pass the check above. The deferral pill (and the deadline folded into
    // the main badge's tooltip) only render when those three fields survive
    // the transform, so assert on them too.
    const deferralBadge = screen.getByTestId('device-reboot-deferrals');
    expect(deferralBadge).toHaveTextContent('Postponed 1 of 3');
    expect(screen.getByTestId('device-reboot-scheduled')).toHaveAttribute(
      'title',
      expect.stringContaining('2099'),
    );
  });
});
