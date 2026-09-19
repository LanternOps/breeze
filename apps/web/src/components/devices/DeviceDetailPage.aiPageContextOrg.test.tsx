import '@/lib/i18n';

import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';

/**
 * #5684 — the device page must publish the device's ORG in its AI page context.
 *
 * Without it the AI store cannot tell that an open chat session belongs to a
 * different tenant, so opening the sidebar on an Org B device while an Org A
 * session is persisted keeps answering about Org A. The store's rebinding is
 * covered in `stores/aiStore.pageContextOrg.test.ts`; this is the wiring half —
 * DeviceDetailPage's API-response → Device transform is an explicit whitelist,
 * so a dropped `orgId` disables the rebinding with nothing else going red.
 */

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const ORG_ID = 'bbbbbbbb-1111-4222-8333-444455556666';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const setPageContextMock = vi.hoisted(() => vi.fn());
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setPageContext: setPageContextMock }),
}));

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => <div data-testid="extension-slot-host-stub" />,
}));
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: () => () => undefined }),
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
  setPageContextMock.mockReset();
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === `/devices/${DEVICE_ID}`) {
      return Promise.resolve(
        jsonResponse({
          id: DEVICE_ID,
          hostname: 'ORGB-WS-01',
          osType: 'windows',
          osVersion: '11',
          status: 'online',
          orgId: ORG_ID,
          siteId: 'site-1',
          agentVersion: '1.0.0',
          tags: [],
          recentMetrics: [],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}, false, 404));
  });
});

describe('DeviceDetailPage AI page context (#5684)', () => {
  it("publishes the device's org alongside its id", async () => {
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);

    await waitFor(() =>
      expect(setPageContextMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'device', id: DEVICE_ID, orgId: ORG_ID }),
      ),
    );
  });
});
