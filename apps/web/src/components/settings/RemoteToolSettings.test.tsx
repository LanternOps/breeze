import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RemoteToolSettings from './RemoteToolSettings';

const mocks = vi.hoisted(() => ({
  saveUserPreferences: vi.fn(),
  fetchWithAuth: vi.fn(),
  can: vi.fn(),
}));

vi.mock('@/lib/userPreferences', () => ({ saveUserPreferences: mocks.saveUserPreferences }));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: mocks.can }) }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));

const DIRECTORY = {
  providers: [
    { id: 'mesh', name: 'MeshCentral', enabled: true },
    { id: 'rust', name: 'RustDesk', enabled: true },
    { id: 'old', name: 'Retired Tool', enabled: false },
  ],
  defaultProviderId: 'mesh',
};

function respondWith(body: unknown, ok = true) {
  mocks.fetchWithAuth.mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body });
}

beforeEach(() => {
  mocks.saveUserPreferences.mockReset().mockResolvedValue({ remoteAccessProviderId: 'rust' });
  mocks.fetchWithAuth.mockReset();
  mocks.can.mockReset().mockReturnValue(true);
});

describe('RemoteToolSettings (#3389)', () => {
  it('renders nothing for a user without remote:access, and never calls the endpoint', async () => {
    mocks.can.mockReturnValue(false);
    respondWith(DIRECTORY);

    const { container } = render(<RemoteToolSettings preferences={{}} />);

    expect(container).toBeEmptyDOMElement();
    // the capability gate must short-circuit the fetch, not just hide the output
    expect(mocks.fetchWithAuth).not.toHaveBeenCalled();
  });

  it('offers only enabled providers plus the tenant default', async () => {
    respondWith(DIRECTORY);
    render(<RemoteToolSettings preferences={{}} />);

    const select = await screen.findByLabelText('Preferred remote tool');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);

    expect(options).toEqual([
      'Use organization default (MeshCentral)',
      'MeshCentral',
      'RustDesk',
    ]);
    expect(options.join()).not.toContain('Retired Tool');
  });

  it('saves the chosen provider id', async () => {
    respondWith(DIRECTORY);
    render(<RemoteToolSettings preferences={{}} />);

    const select = await screen.findByLabelText('Preferred remote tool');
    await userEvent.selectOptions(select, 'rust');

    await waitFor(() => expect(mocks.saveUserPreferences).toHaveBeenCalledTimes(1));
    expect(mocks.saveUserPreferences.mock.calls[0]?.[0]).toEqual({ remoteAccessProviderId: 'rust' });
  });

  it('clears the preference to undefined when the default is chosen', async () => {
    respondWith(DIRECTORY);
    render(<RemoteToolSettings preferences={{ remoteAccessProviderId: 'rust' }} />);

    const select = await screen.findByLabelText('Preferred remote tool');
    await userEvent.selectOptions(select, '');

    await waitFor(() => expect(mocks.saveUserPreferences).toHaveBeenCalledTimes(1));
    // undefined, not '' — the server treats absent as "follow tenant default"
    expect(mocks.saveUserPreferences.mock.calls[0]?.[0]).toEqual({ remoteAccessProviderId: undefined });
  });

  it('explains a stale preference rather than silently dropping it', async () => {
    respondWith(DIRECTORY);
    render(<RemoteToolSettings preferences={{ remoteAccessProviderId: 'old' }} />);

    expect(await screen.findByText(/no longer available/i)).toBeTruthy();
  });

  it('distinguishes a failed load from a tenant with no providers', async () => {
    mocks.fetchWithAuth.mockRejectedValue(new Error('network'));
    render(<RemoteToolSettings preferences={{}} />);

    expect(await screen.findByText(/Couldn't load the available remote tools/i)).toBeTruthy();
    expect(screen.queryByText(/No remote tools are configured/i)).toBeNull();
  });

  it('says so plainly when the tenant has configured none', async () => {
    respondWith({ providers: [], defaultProviderId: null });
    render(<RemoteToolSettings preferences={{}} />);

    expect(await screen.findByText(/No remote tools are configured/i)).toBeTruthy();
  });

  it('reverts the selection when saving fails', async () => {
    respondWith(DIRECTORY);
    mocks.saveUserPreferences.mockRejectedValue(new Error('nope'));
    render(<RemoteToolSettings preferences={{ remoteAccessProviderId: 'mesh' }} />);

    const select = await screen.findByLabelText('Preferred remote tool') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'rust');

    await waitFor(() => expect(select.value).toBe('mesh'));
  });
});
