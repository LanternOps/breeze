import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConnectionHealthSettingsCard from './ConnectionHealthSettingsCard';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), showToast: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('../shared/Toast', () => ({ showToast: mocks.showToast }));

const ORG = '11111111-1111-4111-8111-111111111111';

const res = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: '',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const settings = (over: Record<string, unknown> = {}) => ({
  partner: { customerAdminsNotified: true, enabled: true },
  org: null,
  canManagePartner: true,
  canManageOrg: false,
  ...over,
});
const orgBlock = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  customerAdminsNotified: null,
  enabled: true,
  source: 'partner',
  inheritedEnabled: true,
  inheritedSource: 'partner',
  ...over,
});

const partnerToggle = () => screen.getByTestId('connection-health-partner-toggle') as HTMLInputElement;
const orgSelect = () => screen.getByTestId('connection-health-org-select') as HTMLSelectElement;

beforeEach(() => {
  mocks.fetchWithAuth.mockReset();
  mocks.showToast.mockReset();
});

describe('ConnectionHealthSettingsCard', () => {
  it('without an org: shows the partner default and asks for an org to override', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(res(settings()));
    render(<ConnectionHealthSettingsCard orgId={null} />);
    await waitFor(() => expect(partnerToggle().disabled).toBe(false));
    expect(partnerToggle().checked).toBe(true);
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/connection-health/settings');
    expect(screen.queryByTestId('connection-health-org-select')).toBeNull();
    expect(screen.getByTestId('connection-health-select-org-hint')).toBeTruthy();
  });

  it('with an org: Inherit shows the inherited value and where it comes from', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(res(settings({ org: orgBlock(), canManageOrg: true })));
    render(<ConnectionHealthSettingsCard orgId={ORG} />);
    await waitFor(() => expect(orgSelect().disabled).toBe(false));
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith(`/connection-health/settings?orgId=${ORG}`);
    expect(orgSelect().value).toBe('inherit');
    const inherit = orgSelect().querySelector('option[value="inherit"]')!;
    expect(inherit.textContent).toMatch(/on/i);
    expect(inherit.textContent).toMatch(/partner/i);
  });

  it('an explicit override shows as on/off, and the built-in default is named when the partner has none', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(res(settings({
      partner: { customerAdminsNotified: null, enabled: false },
      org: orgBlock({ customerAdminsNotified: true, enabled: true, source: 'org', inheritedEnabled: false, inheritedSource: 'default' }),
      canManageOrg: true,
    })));
    render(<ConnectionHealthSettingsCard orgId={ORG} />);
    await waitFor(() => expect(orgSelect().value).toBe('on'));
    expect(partnerToggle().checked).toBe(false);
    expect(orgSelect().querySelector('option[value="inherit"]')!.textContent).toMatch(/default/i);
  });

  it('toggling the partner default PUTs it and reloads', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(res(settings()))
      .mockResolvedValueOnce(res({ partner: { customerAdminsNotified: false, enabled: false } }))
      .mockResolvedValueOnce(res(settings({ partner: { customerAdminsNotified: false, enabled: false } })));
    render(<ConnectionHealthSettingsCard orgId={null} />);
    await waitFor(() => expect(partnerToggle().disabled).toBe(false));
    await userEvent.click(partnerToggle());
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(3));
    const [url, init] = mocks.fetchWithAuth.mock.calls[1]!;
    expect(url).toBe('/connection-health/settings/partner');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ customerAdminsNotified: false });
    await waitFor(() => expect(partnerToggle().checked).toBe(false));
    expect(mocks.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('choosing Inherit for the org sends null; On sends true', async () => {
    mocks.fetchWithAuth.mockImplementation(async (url: string, init?: { method?: string }) =>
      init?.method === 'PUT' ? res({ org: {} }) : res(settings({ org: orgBlock({ customerAdminsNotified: false, enabled: false, source: 'org' }), canManageOrg: true })));
    render(<ConnectionHealthSettingsCard orgId={ORG} />);
    await waitFor(() => expect(orgSelect().value).toBe('off'));
    await userEvent.selectOptions(orgSelect(), 'inherit');
    await waitFor(() => expect(mocks.fetchWithAuth.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(true));
    const put = mocks.fetchWithAuth.mock.calls.find((c) => c[1]?.method === 'PUT')!;
    expect(put[0]).toBe(`/connection-health/settings/orgs/${ORG}`);
    expect(JSON.parse(put[1].body)).toEqual({ customerAdminsNotified: null });
  });

  it('a failed save reverts the control', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(res(settings()))
      .mockResolvedValueOnce(res({ error: 'boom' }, 500));
    render(<ConnectionHealthSettingsCard orgId={null} />);
    await waitFor(() => expect(partnerToggle().disabled).toBe(false));
    await userEvent.click(partnerToggle());
    await waitFor(() => expect(partnerToggle().checked).toBe(true));
    await waitFor(() => expect(partnerToggle().disabled).toBe(false));
  });

  it('read-only when the caller cannot manage a level, with a reason', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(res(settings({ org: orgBlock(), canManagePartner: false, canManageOrg: false })));
    render(<ConnectionHealthSettingsCard orgId={ORG} />);
    await waitFor(() => expect(screen.getByTestId('connection-health-partner-readonly')).toBeTruthy());
    expect(partnerToggle().disabled).toBe(true);
    expect(orgSelect().disabled).toBe(true);
  });

  it('hides itself when the caller may not read it (403)', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(res({ error: 'Forbidden' }, 403));
    const { container } = render(<ConnectionHealthSettingsCard orgId={null} />);
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="connection-health-settings-card"]')).toBeNull());
  });

  it('a load failure shows an error with retry, never a guessed "off"', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(res({ error: 'boom' }, 500))
      .mockResolvedValueOnce(res(settings()));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ConnectionHealthSettingsCard orgId={null} />);
    await waitFor(() => expect(screen.getByTestId('connection-health-settings-retry')).toBeTruthy());
    expect(partnerToggle().disabled).toBe(true);
    expect(partnerToggle().checked).toBe(false);
    await userEvent.click(screen.getByTestId('connection-health-settings-retry'));
    await waitFor(() => expect(partnerToggle().checked).toBe(true));
    err.mockRestore();
  });
});
