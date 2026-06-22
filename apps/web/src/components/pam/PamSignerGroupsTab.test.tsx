import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamSignerGroupsTab from './PamSignerGroupsTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import type { PamSignerGroup } from './types';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const trustedGroup: PamSignerGroup = {
  id: 'grp-1',
  orgId: 'org-1',
  name: 'Trusted vendors',
  description: 'Approved publishers',
  signers: ['Acme Corp', 'Microsoft Corporation'],
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
};

/** URL-routed fetch mock, mirroring PamRulesTab.test. */
function installFetchRoutes({
  groups = [] as PamSignerGroup[],
  deleteResponse,
}: {
  groups?: PamSignerGroup[];
  deleteResponse?: () => Response;
} = {}) {
  fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/pam/signer-groups/') && method === 'DELETE') {
      return deleteResponse ? deleteResponse() : makeJsonResponse({ success: true });
    }
    if (url.startsWith('/pam/signer-groups/') && method === 'PATCH') {
      return makeJsonResponse({ success: true, signerGroup: groups[0] ?? trustedGroup });
    }
    if (url === '/pam/signer-groups' && method === 'POST') {
      return makeJsonResponse({ success: true, signerGroup: groups[0] ?? trustedGroup }, true, 201);
    }
    return makeJsonResponse({ success: true, signerGroups: groups });
  });
}

function findMutationCall(urlPrefix: string, method: string) {
  return fetchWithAuthMock.mock.calls.find(
    (c) =>
      typeof c[0] === 'string' &&
      c[0].startsWith(urlPrefix) &&
      (c[1] as RequestInit | undefined)?.method === method,
  );
}

function bodyOf(call: ReturnType<typeof findMutationCall>): Record<string, unknown> {
  return JSON.parse((call?.[1] as RequestInit).body as string);
}

async function openCreateModal() {
  await waitFor(() => screen.getByTestId('pam-add-signer-group-btn'));
  fireEvent.click(screen.getByTestId('pam-add-signer-group-btn'));
}

describe('PamSignerGroupsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when no groups exist', async () => {
    installFetchRoutes({ groups: [] });
    render(<PamSignerGroupsTab />);
    await waitFor(() => {
      expect(screen.getByText('No signer groups yet')).toBeInTheDocument();
    });
  });

  it('lists groups with name, signer count, and members', async () => {
    installFetchRoutes({ groups: [trustedGroup] });
    render(<PamSignerGroupsTab />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-signer-group-row-grp-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pam-signer-group-name-grp-1')).toHaveTextContent('Trusted vendors');
    const cell = screen.getByTestId('pam-signer-group-signers-grp-1');
    expect(cell).toHaveTextContent('2');
    expect(cell).toHaveTextContent('Acme Corp, Microsoft Corporation');
  });

  it('re-fetches when the liveTick prop changes', async () => {
    installFetchRoutes({ groups: [trustedGroup] });
    const { rerender } = render(<PamSignerGroupsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-signer-group-row-grp-1'));
    const before = fetchWithAuthMock.mock.calls.filter((c) => c[0] === '/pam/signer-groups').length;

    rerender(<PamSignerGroupsTab liveTick={1} />);
    await waitFor(() => {
      const after = fetchWithAuthMock.mock.calls.filter((c) => c[0] === '/pam/signer-groups').length;
      expect(after).toBe(before + 1);
    });
  });

  it('creates a group with name, description, and signer rows', async () => {
    const user = userEvent.setup();
    installFetchRoutes({ groups: [] });
    render(<PamSignerGroupsTab />);
    await openCreateModal();

    await user.type(screen.getByTestId('pam-signer-group-name'), 'Trusted vendors');
    await user.type(screen.getByTestId('pam-signer-group-description'), 'Approved publishers');
    await user.type(screen.getByTestId('pam-signer-group-signer-0'), 'Acme Corp');
    // Add a second signer row.
    fireEvent.click(screen.getByTestId('pam-signer-group-add-signer'));
    await user.type(screen.getByTestId('pam-signer-group-signer-1'), 'Microsoft Corporation');

    fireEvent.click(screen.getByTestId('pam-signer-group-save'));

    await waitFor(() => {
      expect(findMutationCall('/pam/signer-groups', 'POST')).toBeDefined();
    });
    const payload = bodyOf(findMutationCall('/pam/signer-groups', 'POST'));
    expect(payload).toMatchObject({
      name: 'Trusted vendors',
      description: 'Approved publishers',
      signers: ['Acme Corp', 'Microsoft Corporation'],
    });
  });

  it('drops blank signer rows from the create payload', async () => {
    const user = userEvent.setup();
    installFetchRoutes({ groups: [] });
    render(<PamSignerGroupsTab />);
    await openCreateModal();

    await user.type(screen.getByTestId('pam-signer-group-name'), 'One signer');
    await user.type(screen.getByTestId('pam-signer-group-signer-0'), 'Acme Corp');
    // Add an empty second row and leave it blank.
    fireEvent.click(screen.getByTestId('pam-signer-group-add-signer'));
    fireEvent.click(screen.getByTestId('pam-signer-group-save'));

    await waitFor(() => {
      expect(findMutationCall('/pam/signer-groups', 'POST')).toBeDefined();
    });
    expect(bodyOf(findMutationCall('/pam/signer-groups', 'POST')).signers).toEqual(['Acme Corp']);
  });

  it('removes a signer row', async () => {
    const user = userEvent.setup();
    installFetchRoutes({ groups: [] });
    render(<PamSignerGroupsTab />);
    await openCreateModal();

    await user.type(screen.getByTestId('pam-signer-group-name'), 'Two then one');
    await user.type(screen.getByTestId('pam-signer-group-signer-0'), 'Acme Corp');
    fireEvent.click(screen.getByTestId('pam-signer-group-add-signer'));
    await user.type(screen.getByTestId('pam-signer-group-signer-1'), 'Beta Inc');
    // Remove the first row.
    fireEvent.click(screen.getByTestId('pam-signer-group-remove-signer-0'));
    fireEvent.click(screen.getByTestId('pam-signer-group-save'));

    await waitFor(() => {
      expect(findMutationCall('/pam/signer-groups', 'POST')).toBeDefined();
    });
    expect(bodyOf(findMutationCall('/pam/signer-groups', 'POST')).signers).toEqual(['Beta Inc']);
  });

  it('edits a group via PATCH, pre-filling existing signers', async () => {
    const user = userEvent.setup();
    installFetchRoutes({ groups: [trustedGroup] });
    render(<PamSignerGroupsTab />);
    await waitFor(() => screen.getByTestId('pam-signer-group-edit-grp-1'));
    fireEvent.click(screen.getByTestId('pam-signer-group-edit-grp-1'));

    await waitFor(() => {
      expect((screen.getByTestId('pam-signer-group-signer-0') as HTMLInputElement).value).toBe('Acme Corp');
    });
    expect((screen.getByTestId('pam-signer-group-signer-1') as HTMLInputElement).value).toBe(
      'Microsoft Corporation',
    );

    await user.clear(screen.getByTestId('pam-signer-group-name'));
    await user.type(screen.getByTestId('pam-signer-group-name'), 'Trusted vendors v2');
    fireEvent.click(screen.getByTestId('pam-signer-group-save'));

    await waitFor(() => {
      expect(findMutationCall('/pam/signer-groups/grp-1', 'PATCH')).toBeDefined();
    });
    expect(bodyOf(findMutationCall('/pam/signer-groups/grp-1', 'PATCH')).name).toBe('Trusted vendors v2');
  });

  it('gates deletion behind a confirm dialog', async () => {
    installFetchRoutes({ groups: [trustedGroup] });
    render(<PamSignerGroupsTab />);
    await waitFor(() => screen.getByTestId('pam-signer-group-delete-grp-1'));

    fireEvent.click(screen.getByTestId('pam-signer-group-delete-grp-1'));
    await waitFor(() => screen.getByTestId('pam-signer-group-delete-confirm'));
    expect(findMutationCall('/pam/signer-groups/grp-1', 'DELETE')).toBeUndefined();

    fireEvent.click(screen.getByTestId('pam-signer-group-delete-confirm'));
    await waitFor(() => {
      expect(findMutationCall('/pam/signer-groups/grp-1', 'DELETE')).toBeDefined();
    });
  });

  it('surfaces a 409 "in use" error via toast on delete', async () => {
    installFetchRoutes({
      groups: [trustedGroup],
      deleteResponse: () =>
        makeJsonResponse(
          { error: 'Signer group is used by 2 rule(s); remove those references first' },
          false,
          409,
        ),
    });
    render(<PamSignerGroupsTab />);
    await waitFor(() => screen.getByTestId('pam-signer-group-delete-grp-1'));

    fireEvent.click(screen.getByTestId('pam-signer-group-delete-grp-1'));
    await waitFor(() => screen.getByTestId('pam-signer-group-delete-confirm'));
    fireEvent.click(screen.getByTestId('pam-signer-group-delete-confirm'));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('used by 2 rule(s)'),
        }),
      );
    });
  });
});
