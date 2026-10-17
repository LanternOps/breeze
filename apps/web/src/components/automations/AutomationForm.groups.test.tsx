import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AutomationForm from './AutomationForm';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const ORG = '11111111-1111-4111-8111-111111111111';

const groups = [
  { id: 'g-1', name: 'Front desk', type: 'static', filterFieldsUsed: [], deviceCount: 3 },
  { id: 'g-2', name: 'Windows servers', type: 'dynamic', filterFieldsUsed: ['osType'], deviceCount: 5 },
  { id: 'g-3', name: 'Named hosts', type: 'dynamic', filterFieldsUsed: ['hostname'], deviceCount: 1 },
];

function respond(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/device-groups')) return respond({ data: groups });
    return respond({ data: [], page: { nextCursor: null, returned: 0, total: 0, hasMore: false, observedAt: '' } });
  });
});

const advancedDefaults = { name: 'Tidy', targetConfig: { type: 'all' as const } };

describe('AutomationForm groups target mode (#8599)', () => {
  it('offers Device Groups for an org-owned automation, scoped to the owner org, and submits groupIds', async () => {
    const onSubmit = vi.fn();
    render(
      <AutomationForm
        onSubmit={onSubmit}
        ownerOrgId={ORG}
        defaultValues={{ ...advancedDefaults, ownerScope: 'organization' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Device Groups/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Front desk/ }));

    expect(fetchMock.mock.calls.some(([url]) => url === `/device-groups?orgId=${ORG}`)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Save automation/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0].targetConfig).toEqual({ type: 'groups', groupIds: ['g-1'] });
  });

  it('flags dynamic groups and disables a group whose rules the server would refuse', async () => {
    render(<AutomationForm ownerOrgId={ORG} defaultValues={{ ...advancedDefaults, ownerScope: 'organization' }} />);
    fireEvent.click(screen.getByRole('button', { name: /Device Groups/i }));

    const refused = (await screen.findByRole('checkbox', { name: /Named hosts/ })) as HTMLInputElement;
    expect(refused.disabled).toBe(true);
    expect(screen.getByTestId('group-refused-g-3').textContent).toContain('hostname');
    expect(screen.getByTestId('group-dynamic-g-2')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: /Windows servers/ }) as HTMLInputElement).disabled).toBe(false);
  });

  it('does not offer Device Groups for a partner-wide automation and says why', () => {
    render(<AutomationForm defaultValues={{ ...advancedDefaults, ownerScope: 'partner' }} />);
    expect(screen.queryByRole('button', { name: /Device Groups/i })).toBeNull();
    expect(screen.getByRole('button', { name: /All Devices/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Advanced Filter/i })).toBeTruthy();
    expect(screen.getByTestId('automation-target-partner-note').textContent).toMatch(/single organization/i);
  });

  it('hides Device Groups when the owner switches to partner-wide on create', () => {
    render(
      <AutomationForm
        showOwnerScope
        defaultValues={{ ...advancedDefaults, ownerScope: 'organization' }}
        ownerOrgId={ORG}
      />,
    );
    expect(screen.getByRole('button', { name: /Device Groups/i })).toBeTruthy();
    fireEvent.click(screen.getByTestId('automation-owner-partner'));
    expect(screen.queryByRole('button', { name: /Device Groups/i })).toBeNull();
  });

  it('blocks saving a stored partner-wide groups target and explains how to fix it', async () => {
    const onSubmit = vi.fn();
    render(
      <AutomationForm
        onSubmit={onSubmit}
        defaultValues={{ name: 'Old', ownerScope: 'partner', targetConfig: { type: 'groups', groupIds: ['g-1'] } }}
      />,
    );
    const notice = screen.getByTestId('automation-target-partner-blocked');
    expect(notice.textContent).toMatch(/All Devices or an Advanced Filter/i);
    const save = screen.getByRole('button', { name: /Save automation/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
