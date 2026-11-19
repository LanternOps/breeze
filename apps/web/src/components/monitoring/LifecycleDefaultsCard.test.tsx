import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LifecycleDefaultsCard from './LifecycleDefaultsCard';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';

const authUser: { canManagePartnerWide?: boolean } = {};
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: unknown) => unknown) => selector({ user: authUser }),
}));
let orgScope: Record<string, unknown>;
vi.mock('@/hooks/useOrgScope', () => ({ useOrgScope: () => orgScope }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const orgSelected = (orgId = ORG_ID) => ({ ready: true, status: 'resolved', scope: 'org', orgId, org: null, error: null });
const allOrgs = { ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null };

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const PARTNER = { autoResolve: false, rearmMode: 'new_evidence', rearmDelayMinutes: null, cooldownMinutes: 5 };
const defaults = (over: Record<string, unknown> = {}) => ({
  partner: PARTNER,
  org: { autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: null },
  effective: PARTNER,
  sources: { autoResolve: 'partner', rearmMode: 'partner', rearmDelayMinutes: 'partner', cooldownMinutes: 'partner' },
  monitorOverrideCounts: { autoResolve: 0, rearmMode: 0, rearmDelayMinutes: 0, cooldownMinutes: 0 },
  ...over,
});

function install(opts: { get?: () => Response; put?: () => Response } = {}) {
  fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return opts.put ? opts.put() : json({ data: {} });
    return opts.get ? opts.get() : json(defaults());
  });
}

const putBody = () => {
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
  return JSON.parse((call![1] as RequestInit).body as string);
};
const putCount = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT').length;

describe('LifecycleDefaultsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete authUser.canManagePartnerWide;
    orgScope = orgSelected();
  });

  it('shows inherited value and source at org scope', async () => {
    install({
      get: () => json(defaults({
        partner: { autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 30, cooldownMinutes: 15 },
        effective: { autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 30, cooldownMinutes: 15 },
      })),
    });
    render(<LifecycleDefaultsCard />);

    const autoResolve = await screen.findByTestId('lifecycle-auto-resolve');
    expect(fetchMock).toHaveBeenCalledWith(`/alerts/lifecycle-defaults?orgId=${ORG_ID}`, expect.anything());
    expect(autoResolve).toHaveValue('');
    expect(within(autoResolve).getByRole('option', { name: 'Inherit (On, Partner default)' })).toBeInTheDocument();

    const rearm = screen.getByTestId('lifecycle-rearm-mode');
    expect(rearm).toHaveValue('');
    expect(within(rearm).getByRole('option', { name: 'Inherit (After 30 minutes, Partner default)' })).toBeInTheDocument();

    const cooldown = screen.getByTestId('lifecycle-cooldown');
    expect(cooldown).toHaveValue(null);
    expect(cooldown).toHaveAttribute('placeholder', '15');
    expect(screen.getByText('Inherits from Partner default')).toBeInTheDocument();
    // The inherited mode is after_delay, but the delay belongs to the inherited pair.
    expect(screen.queryByTestId('lifecycle-rearm-delay')).toBeNull();
  });

  it('labels the save button for defaults, not for a monitor', async () => {
    install();
    render(<LifecycleDefaultsCard />);

    expect(await screen.findByTestId('lifecycle-save')).toHaveTextContent('Save defaults');
  });

  it('loads the org override and says what it overrides', async () => {
    install({
      get: () => json(defaults({
        org: { autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 45, cooldownMinutes: 20 },
      })),
    });
    render(<LifecycleDefaultsCard />);

    expect(await screen.findByTestId('lifecycle-auto-resolve')).toHaveValue('true');
    expect(screen.getByTestId('lifecycle-rearm-mode')).toHaveValue('after_delay');
    expect(screen.getByTestId('lifecycle-rearm-delay')).toHaveValue(45);
    expect(screen.getByTestId('lifecycle-cooldown')).toHaveValue(20);
    expect(screen.getByText('Overrides Partner default (Off)')).toBeInTheDocument();
    expect(screen.getByText('Overrides Partner default (New evidence)')).toBeInTheDocument();
    expect(screen.getByText('Overrides Partner default (5)')).toBeInTheDocument();
  });

  it('names the built-in default when the partner level has no value of its own', async () => {
    install({
      get: () => json(defaults({
        sources: { autoResolve: 'builtin', rearmMode: 'builtin', rearmDelayMinutes: 'builtin', cooldownMinutes: 'builtin' },
      })),
    });
    render(<LifecycleDefaultsCard />);

    const autoResolve = await screen.findByTestId('lifecycle-auto-resolve');
    expect(within(autoResolve).getByRole('option', { name: 'Inherit (Off, Built-in default)' })).toBeInTheDocument();
  });

  it('blank saves null', async () => {
    install({
      get: () => json(defaults({
        org: { autoResolve: true, rearmMode: 'after_delay', rearmDelayMinutes: 45, cooldownMinutes: 20 },
      })),
    });
    render(<LifecycleDefaultsCard />);

    fireEvent.change(await screen.findByTestId('lifecycle-auto-resolve'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('lifecycle-rearm-mode'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('lifecycle-cooldown'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('lifecycle-save'));

    await waitFor(() => expect(putCount()).toBe(1));
    expect(fetchMock.mock.calls.find(([, i]) => (i as RequestInit)?.method === 'PUT')![0]).toBe('/alerts/lifecycle-defaults');
    expect(putBody()).toEqual({
      scope: 'organization',
      orgId: ORG_ID,
      autoResolve: null,
      rearmMode: null,
      rearmDelayMinutes: null,
      cooldownMinutes: null,
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('0 is a real cooldown, not inherit', async () => {
    install({ get: () => json(defaults({ org: { autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: 0 } })) });
    render(<LifecycleDefaultsCard />);

    const cooldown = await screen.findByTestId('lifecycle-cooldown');
    expect(cooldown).toHaveValue(0);
    fireEvent.change(screen.getByTestId('lifecycle-auto-resolve'), { target: { value: 'false' } });
    fireEvent.click(screen.getByTestId('lifecycle-save'));

    await waitFor(() => expect(putCount()).toBe(1));
    expect(putBody()).toMatchObject({ autoResolve: false, cooldownMinutes: 0 });
  });

  it('partner scope has no inherit option', async () => {
    orgScope = allOrgs;
    install({ get: () => json(defaults({ org: null })) });
    render(<LifecycleDefaultsCard />);

    const autoResolve = await screen.findByTestId('lifecycle-auto-resolve');
    expect(fetchMock.mock.calls[0]![0]).toBe('/alerts/lifecycle-defaults');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ skipOrgIdInjection: true });
    expect(within(autoResolve).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['true', 'false']);
    const rearm = screen.getByTestId('lifecycle-rearm-mode');
    expect(within(rearm).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['new_evidence', 'after_delay']);
    expect(screen.getByTestId('lifecycle-cooldown')).toHaveValue(5);
    expect(screen.queryByText(/Inherits from/)).toBeNull();
  });

  it('partner scope saves concrete values and refuses a blank cooldown', async () => {
    orgScope = allOrgs;
    install({ get: () => json(defaults({ org: null })) });
    render(<LifecycleDefaultsCard />);

    fireEvent.change(await screen.findByTestId('lifecycle-cooldown'), { target: { value: '' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number from 0 to 1440.');
    expect(screen.getByTestId('lifecycle-save')).toBeDisabled();

    fireEvent.change(screen.getByTestId('lifecycle-cooldown'), { target: { value: '10' } });
    fireEvent.change(screen.getByTestId('lifecycle-auto-resolve'), { target: { value: 'true' } });
    fireEvent.click(screen.getByTestId('lifecycle-save'));

    await waitFor(() => expect(putCount()).toBe(1));
    expect(putBody()).toEqual({
      scope: 'partner',
      autoResolve: true,
      rearmMode: 'new_evidence',
      rearmDelayMinutes: null,
      cooldownMinutes: 10,
    });
  });

  it('partner scope works for a partner with no organizations yet', async () => {
    orgScope = { ready: false, status: 'empty', scope: null, orgId: null, org: null, error: null };
    install({ get: () => json(defaults({ org: null })) });
    render(<LifecycleDefaultsCard />);

    await screen.findByTestId('lifecycle-save');
    expect(fetchMock.mock.calls[0]![0]).toBe('/alerts/lifecycle-defaults');
  });

  it('partner scope is read-only without partner-wide rights', async () => {
    orgScope = allOrgs;
    authUser.canManagePartnerWide = false;
    install({ get: () => json(defaults({ org: null })) });
    render(<LifecycleDefaultsCard />);

    expect(await screen.findByTestId('lifecycle-auto-resolve')).toBeDisabled();
    expect(screen.getByTestId('lifecycle-rearm-mode')).toBeDisabled();
    expect(screen.getByTestId('lifecycle-cooldown')).toBeDisabled();
    expect(screen.queryByTestId('lifecycle-save')).toBeNull();
    expect(screen.getByText('You do not have permission to change the partner default.')).toBeInTheDocument();
  });

  it('after_delay reveals minutes', async () => {
    install();
    render(<LifecycleDefaultsCard />);

    await screen.findByTestId('lifecycle-rearm-mode');
    expect(screen.queryByTestId('lifecycle-rearm-delay')).toBeNull();
    fireEvent.change(screen.getByTestId('lifecycle-rearm-mode'), { target: { value: 'after_delay' } });

    const delay = screen.getByTestId('lifecycle-rearm-delay');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number of minutes from 1 to 1440.');
    expect(screen.getByTestId('lifecycle-save')).toBeDisabled();

    fireEvent.change(delay, { target: { value: '30' } });
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByTestId('lifecycle-save'));

    await waitFor(() => expect(putCount()).toBe(1));
    expect(putBody()).toMatchObject({ rearmMode: 'after_delay', rearmDelayMinutes: 30 });
  });

  it('leaving after_delay drops the minutes from the payload', async () => {
    install({ get: () => json(defaults({ org: { autoResolve: null, rearmMode: 'after_delay', rearmDelayMinutes: 45, cooldownMinutes: null } })) });
    render(<LifecycleDefaultsCard />);

    fireEvent.change(await screen.findByTestId('lifecycle-rearm-mode'), { target: { value: 'new_evidence' } });
    expect(screen.queryByTestId('lifecycle-rearm-delay')).toBeNull();
    fireEvent.click(screen.getByTestId('lifecycle-save'));

    await waitFor(() => expect(putCount()).toBe(1));
    expect(putBody()).toMatchObject({ rearmMode: 'new_evidence', rearmDelayMinutes: null });
  });

  it('save failure toasts via runAction and keeps the edit', async () => {
    install({ put: () => json({ error: 'Cooldown rejected' }, false, 400) });
    render(<LifecycleDefaultsCard />);

    fireEvent.change(await screen.findByTestId('lifecycle-cooldown'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('lifecycle-save'));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Cooldown rejected' })),
    );
    expect(screen.getByTestId('lifecycle-cooldown')).toHaveValue(12);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('lifecycle-save')).not.toBeDisabled();
  });

  it('save reloads the values from the server', async () => {
    let saved = false;
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        saved = true;
        return json({ data: {} });
      }
      return json(defaults({
        org: { autoResolve: null, rearmMode: null, rearmDelayMinutes: null, cooldownMinutes: saved ? 12 : null },
        monitorOverrideCounts: { autoResolve: 0, rearmMode: 0, rearmDelayMinutes: 0, cooldownMinutes: saved ? 2 : 0 },
      }));
    });
    render(<LifecycleDefaultsCard />);

    fireEvent.change(await screen.findByTestId('lifecycle-cooldown'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('lifecycle-save'));

    await screen.findByText('2 monitors override this');
    expect(screen.getByTestId('lifecycle-save')).toBeDisabled();
  });

  it('shows how many monitors override each field', async () => {
    install({
      get: () => json(defaults({ monitorOverrideCounts: { autoResolve: 3, rearmMode: 1, rearmDelayMinutes: 0, cooldownMinutes: 0 } })),
    });
    render(<LifecycleDefaultsCard />);

    await screen.findByText('3 monitors override this');
    expect(screen.getByText('1 monitor overrides this')).toBeInTheDocument();
    expect(screen.queryByText(/0 monitors override this/)).toBeNull();
  });

  it('a failed load shows an error and retry, never an editable form', async () => {
    install({ get: () => json({ error: 'nope' }, false, 500) });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<LifecycleDefaultsCard />);

    await screen.findByText('Could not load the lifecycle defaults.');
    expect(screen.queryByTestId('lifecycle-save')).toBeNull();
    expect(screen.queryByTestId('lifecycle-cooldown')).toBeNull();

    install();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('lifecycle-save');
    warn.mockRestore();
  });

  it('switching org never shows or saves the previous org\'s values', async () => {
    fetchMock.mockImplementation(async (input: string) =>
      json(defaults({
        org: {
          autoResolve: null,
          rearmMode: null,
          rearmDelayMinutes: null,
          cooldownMinutes: input.includes(OTHER_ORG_ID) ? 99 : 20,
        },
      })),
    );
    const view = render(<LifecycleDefaultsCard />);
    expect(await screen.findByTestId('lifecycle-cooldown')).toHaveValue(20);

    orgScope = orgSelected(OTHER_ORG_ID);
    view.rerender(<LifecycleDefaultsCard />);
    expect(screen.queryByTestId('lifecycle-cooldown')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('lifecycle-cooldown')).toHaveValue(99));
  });

  it('switching org during a save still loads the new org', async () => {
    let finishPut: (response: Response) => void = () => {};
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Promise<Response>((resolve) => { finishPut = resolve; });
      return json(defaults({
        org: {
          autoResolve: null,
          rearmMode: null,
          rearmDelayMinutes: null,
          cooldownMinutes: input.includes(OTHER_ORG_ID) ? 99 : 20,
        },
      }));
    });
    const view = render(<LifecycleDefaultsCard />);

    fireEvent.change(await screen.findByTestId('lifecycle-cooldown'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('lifecycle-save'));
    await waitFor(() => expect(putCount()).toBe(1));

    orgScope = orgSelected(OTHER_ORG_ID);
    view.rerender(<LifecycleDefaultsCard />);
    await waitFor(() => expect(screen.getByTestId('lifecycle-cooldown')).toHaveValue(99));

    finishPut(json({ data: {} }));
    await waitFor(() => expect(screen.getByTestId('lifecycle-cooldown')).not.toBeDisabled());
    expect(screen.getByTestId('lifecycle-cooldown')).toHaveValue(99);
    expect(putBody()).toMatchObject({ orgId: ORG_ID, cooldownMinutes: 12 });
  });

  it('a failed reload after a save says so and keeps the form', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let saved = false;
    fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        saved = true;
        return json({ data: {} });
      }
      return saved ? json({ error: 'nope' }, false, 500) : json(defaults());
    });
    render(<LifecycleDefaultsCard />);

    fireEvent.change(await screen.findByTestId('lifecycle-cooldown'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('lifecycle-save'));

    await screen.findByText('Could not load the lifecycle defaults.');
    expect(screen.getByTestId('lifecycle-cooldown')).toHaveValue(12);
    warn.mockRestore();
  });

  it('waits for the org context before loading anything', async () => {
    orgScope = { ready: false, status: 'loading', scope: null, orgId: null, org: null, error: null };
    install();
    render(<LifecycleDefaultsCard />);

    expect(screen.getByTestId('lifecycle-defaults-card')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
