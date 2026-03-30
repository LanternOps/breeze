import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import C2CDashboard from './C2CDashboard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./C2CConnectionWizard', () => ({
  default: () => <div>C2C Connection Wizard</div>,
}));

vi.mock('./C2CRestoreDialog', () => ({
  default: () => <div>C2C Restore Dialog</div>,
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('C2CDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/c2c/connections' || url === '/c2c/configs' || url === '/c2c/jobs' || url === '/c2c/items') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({}, false, 404);
    });
  });

  it('renders the alpha banner, Add Connection button, and empty connection table', async () => {
    render(<C2CDashboard />);

    await screen.findByText('Cloud-to-Cloud Backup');
    expect(
      screen.getByText(
        /Cloud-to-cloud backup for Microsoft 365 and Google Workspace is in early access/i
      )
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Connection' })).toBeTruthy();
    expect(
      await screen.findByText(/No connections configured yet\. Click "Add Connection" to get started\./i)
    ).toBeTruthy();
  });

  it('renders four tabs and empty states for each dataset', async () => {
    render(<C2CDashboard />);

    await screen.findByText(/No connections configured yet/i);
    expect(screen.getByRole('button', { name: 'Connections' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Configs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Jobs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Items' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Configs' }));
    await screen.findByText('No backup configs yet. Add a connection first, then configure backups.');

    fireEvent.click(screen.getByRole('button', { name: 'Jobs' }));
    await screen.findByText('No sync jobs have run yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Items' }));
    await screen.findByText('No items found. Run a sync to populate backup items.');
  });

  it('opens the add connection wizard when the button is clicked', async () => {
    render(<C2CDashboard />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add Connection' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add Connection' }));

    expect(screen.getByText('C2C Connection Wizard')).toBeTruthy();
  });
});
