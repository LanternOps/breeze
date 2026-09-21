import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DeviceFilesystemTab from './DeviceFilesystemTab';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({
    ok: false, status: 404, statusText: 'Not Found',
    json: vi.fn().mockResolvedValue({ error: 'No filesystem analysis available yet' }),
  }),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

// The panel is stubbed so this test proves ONE thing and stays immune to the
// panel's own behaviour: that the tab actually renders it. The panel's
// behaviour is covered by SystemCleanupPanel.test.tsx.
vi.mock('./filesystem/SystemCleanupPanel', () => ({
  default: ({ deviceId }: { deviceId: string }) => (
    <div data-testid="system-cleanup-panel-mounted">{deviceId}</div>
  ),
}));

describe('DeviceFilesystemTab — system cleanup mount', () => {
  it('renders SystemCleanupPanel with the device id', async () => {
    render(<DeviceFilesystemTab deviceId="dev-42" osType="linux" />);
    const mounted = await screen.findByTestId('system-cleanup-panel-mounted');
    expect(mounted).toHaveTextContent('dev-42');
  });
});
