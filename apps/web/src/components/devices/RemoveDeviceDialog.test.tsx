import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/deviceActions', () => ({
  fetchRemovalConfig: vi.fn(),
}));
import { fetchRemovalConfig } from '../../services/deviceActions';
import RemoveDeviceDialog from './RemoveDeviceDialog';

const cfg = vi.mocked(fetchRemovalConfig);

beforeEach(() => {
  vi.clearAllMocks();
  cfg.mockResolvedValue({ uninstallDrainWindowHours: 72 });
});

describe('RemoveDeviceDialog', () => {
  it('defaults the agent radio to Uninstall and confirms with uninstallAgent: true', async () => {
    const onConfirm = vi.fn();
    render(<RemoveDeviceDialog open targets={[{ hostname: 'WKSTN-042', status: 'online' }]} onClose={() => {}} onConfirm={onConfirm} confirmTestId="remove-confirm" />);
    expect(screen.getByRole('radio', { name: /uninstall the breeze agent/i })).toBeChecked();
    fireEvent.click(screen.getByTestId('remove-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ uninstallAgent: true });
    await waitFor(() => expect(cfg).toHaveBeenCalled());
  });

  it('confirms with uninstallAgent: false when Leave is chosen', () => {
    const onConfirm = vi.fn();
    render(<RemoveDeviceDialog open targets={[{ hostname: 'WKSTN-042', status: 'offline' }]} onClose={() => {}} onConfirm={onConfirm} confirmTestId="remove-confirm" />);
    fireEvent.click(screen.getByRole('radio', { name: /leave the agent installed/i }));
    fireEvent.click(screen.getByTestId('remove-confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ uninstallAgent: false });
  });

  it('says "queued now" for an online device and never says "runs now"', () => {
    render(<RemoveDeviceDialog open targets={[{ hostname: 'A', status: 'online' }]} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText(/queued now/i)).toBeInTheDocument();
    expect(screen.queryByText(/runs now/i)).toBeNull();
  });

  it('shows the drain window from the API for a not-online device', async () => {
    render(<RemoveDeviceDialog open targets={[{ hostname: 'A', status: 'maintenance' }]} onClose={() => {}} onConfirm={() => {}} />);
    await waitFor(() => expect(screen.getByText(/after 72 hours/i)).toBeInTheDocument());
  });

  it('falls back to window-less copy when the config fetch fails', async () => {
    cfg.mockRejectedValue(new Error('boom'));
    render(<RemoveDeviceDialog open targets={[{ hostname: 'A', status: 'offline' }]} onClose={() => {}} onConfirm={() => {}} />);
    await waitFor(() => expect(cfg).toHaveBeenCalled());
    expect(screen.getByText(/runs the next time the device checks in\.$/i)).toBeInTheDocument();
    expect(screen.queryByText(/after .* hours/i)).toBeNull();
  });

  it('bulk: titles with the count and buckets online vs not-currently-online', () => {
    render(<RemoveDeviceDialog open targets={[
      { hostname: 'A', status: 'online' },
      { hostname: 'B', status: 'offline' },
      { hostname: 'C', status: 'quarantined' },
    ]} onClose={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText('Remove 3 devices?')).toBeInTheDocument();
    expect(screen.getByText('1 online, 2 not currently online.')).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).toBeNull();
  });
});
