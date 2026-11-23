import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';
import { i18n } from '@/lib/i18n';
import PolicyStateActions from './PolicyStateActions';
import type { ConfigPolicyReach } from '../appliesTo/appliesToApi';

const fetchMock = vi.mocked(fetchWithAuth);
const res = (status: number, payload: unknown): Response =>
  ({
    ok: status < 400,
    status,
    statusText: 'x',
    json: vi.fn().mockResolvedValue(payload),
    text: vi.fn().mockResolvedValue(JSON.stringify(payload)),
    headers: new Headers({ 'content-type': 'application/json' }),
    clone() {
      return this;
    },
  }) as unknown as Response;

const reach = (direct: number, throughChildren = 0, partial = false): ConfigPolicyReach => ({
  direct,
  throughChildren,
  organizations: 1,
  ...(partial ? { partial: true as const } : {}),
});

const renderActions = (props: Partial<React.ComponentProps<typeof PolicyStateActions>> = {}) => {
  const onChanged = vi.fn();
  render(
    <PolicyStateActions
      policyId="pol-1"
      status="inactive"
      reach={reach(212)}
      childPolicyCount={0}
      readOnly={false}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { onChanged };
};

const patchBodies = () =>
  fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    .map(([url, init]) => ({ url, body: JSON.parse(String((init as RequestInit).body)) }));

describe('PolicyStateActions (plan W03c F3)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('en');
  });

  it('Activate states its reach and patches status', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { id: 'pol-1', status: 'active' }));
    const { onChanged } = renderActions();
    const activate = screen.getByTestId('config-policy-activate');
    // Activating starts enforcing on the devices it targets directly.
    expect(activate).toHaveTextContent('Activate · reaches 212 devices');
    fireEvent.click(activate);
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('active'));
    expect(patchBodies()).toEqual([{ url: '/configuration-policies/pol-1', body: { status: 'active' } }]);
  });

  it('Activate on a partial reach says "at least"; an unknown reach states no count', () => {
    renderActions({ reach: reach(212, 0, true) });
    expect(screen.getByTestId('config-policy-activate')).toHaveTextContent('Activate · reaches at least 212 devices');
  });

  it('Activate with an unknown reach states no count', () => {
    renderActions({ reach: null });
    expect(screen.getByTestId('config-policy-activate')).toHaveTextContent(/^Activate$/);
  });

  it('Deactivate says what changes on devices before it patches', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { id: 'pol-1', status: 'inactive' }));
    const { onChanged } = renderActions({ status: 'active', reach: reach(200, 148), childPolicyCount: 3 });
    fireEvent.click(screen.getByTestId('config-policy-deactivate'));
    // Nothing is written until the confirm.
    expect(fetchMock).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('200 devices');
    // A parent is never inert: policies based on it keep its settings.
    expect(dialog).toHaveTextContent('3 policies');
    expect(dialog).toHaveTextContent('148 devices');
    fireEvent.click(screen.getByTestId('config-policy-deactivate-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('inactive'));
    expect(patchBodies()).toEqual([{ url: '/configuration-policies/pol-1', body: { status: 'inactive' } }]);
  });

  it('Deactivate on a policy that targets no visible device says so plainly', () => {
    renderActions({ status: 'active', reach: reach(0, 148), childPolicyCount: 3 });
    fireEvent.click(screen.getByTestId('config-policy-deactivate'));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('It targets no devices you can see directly.');
    expect(dialog).not.toHaveTextContent('they stop receiving');
    expect(dialog).toHaveTextContent('3 policies, 148 devices');
  });

  it('Deactivate never runs the arming gate', async () => {
    // Only the status PATCH: no client-side arming check, no pre-read, and no
    // extra field the server's activation gate would look at.
    fetchMock.mockResolvedValueOnce(res(200, { id: 'pol-1', status: 'inactive' }));
    const { onChanged } = renderActions({ status: 'active' });
    fireEvent.click(screen.getByTestId('config-policy-deactivate'));
    fireEvent.click(screen.getByTestId('config-policy-deactivate-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('inactive'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(patchBodies()[0].body).toEqual({ status: 'inactive' });
    expect(screen.queryByTestId('config-policy-state-error')).toBeNull();
  });

  it('a 403 from the arming gate is shown, not swallowed', async () => {
    // The body checkOemUpdatesArmAllowed returns on PATCH /:id status=active.
    fetchMock.mockResolvedValueOnce(
      res(403, {
        error: 'Turning on vendor updates needs the devices.execute permission.',
        code: 'oem_updates_execute_required',
      }),
    );
    const { onChanged } = renderActions();
    fireEvent.click(screen.getByTestId('config-policy-activate'));
    const alert = await screen.findByTestId('config-policy-state-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert.textContent).toBe(
      i18n.t('policies:configurationPolicies.policyStateActions.activateExecuteRequired'),
    );
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('an inactive policy can be archived, and an archived one restored to inactive', async () => {
    fetchMock.mockResolvedValue(res(200, {}));
    const first = renderActions();
    fireEvent.click(screen.getByTestId('config-policy-archive'));
    await waitFor(() => expect(first.onChanged).toHaveBeenCalledWith('archived'));
    expect(patchBodies().at(-1)!.body).toEqual({ status: 'archived' });

    cleanup();
    const second = renderActions({ status: 'archived' });
    expect(screen.queryAllByTestId('config-policy-activate')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('config-policy-restore'));
    await waitFor(() => expect(second.onChanged).toHaveBeenCalledWith('inactive'));
    expect(patchBodies().at(-1)!.body).toEqual({ status: 'inactive' });
  });

  it('renders no control for a read-only viewer', () => {
    const { container } = render(
      <PolicyStateActions
        policyId="pol-1"
        status="active"
        reach={reach(5)}
        childPolicyCount={0}
        readOnly
        onChanged={vi.fn()}
      />,
    );
    expect(container.querySelector('button')).toBeNull();
  });
});
