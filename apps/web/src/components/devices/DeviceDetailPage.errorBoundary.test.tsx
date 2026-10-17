import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('@sentry/astro', () => ({
  withScope: (cb: (scope: { setTag: () => void; setContext: () => void; captureException: () => void }) => void) =>
    cb({ setTag: vi.fn(), setContext: vi.fn(), captureException: vi.fn() }),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../services/deviceActions', () => ({
  sendDeviceCommand: vi.fn(),
  executeScript: vi.fn(),
  toggleMaintenanceMode: vi.fn(),
  decommissionDevice: vi.fn(),
  clearDeviceSessions: vi.fn(),
  permanentDeleteDevice: vi.fn(),
  sendWakeCommand: vi.fn(),
  watchWakeOutcome: vi.fn(),
  WakeCommandError: class WakeCommandError extends Error {},
  wakeFriendlyErrorMessage: vi.fn(),
}));
// Stand in for any overview card that throws once its data arrives — the
// shape of #8982 (page paints, then a card's render throws and the island
// unmounts).
vi.mock('./DeviceDetails', () => ({
  default: () => {
    throw new Error('overview card exploded');
  },
}));
vi.mock('./DeviceSettingsModal', () => ({ default: () => null }));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));
vi.mock('../remote/ActiveSessionsBanner', () => ({ default: () => null }));

describe('DeviceDetailPage error boundary (#8982)', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'dev-1', hostname: 'divergentdns02', status: 'online', orgId: 'org-1' }),
    } as unknown as Response);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it('renders the visible fallback with the error message instead of a blank island', async () => {
    const { container } = render(<DeviceDetailPage deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByTestId('island-error-fallback')).toBeTruthy());
    expect(screen.getByTestId('island-error-fallback').textContent).toContain('overview card exploded');
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
  });
});
