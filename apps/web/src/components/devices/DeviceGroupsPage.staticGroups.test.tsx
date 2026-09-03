import { i18n } from '@/lib/i18n';

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceGroupsPage from './DeviceGroupsPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // orgStore registers an orgId provider at module load; the component now
  // pulls in orgStore via useFleetOrgOwner, so this export must exist.
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../../hooks/useFilterPreview', () => ({
  useFilterPreview: () => ({
    preview: null,
    loading: false,
    error: undefined,
    refresh: vi.fn(),
  }),
}));

const mockFetch = vi.mocked(fetchWithAuth);

const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const DEVICES = [
  { id: 'device-1', hostname: 'web-01', osType: 'windows', siteId: 'site-1' },
  { id: 'device-2', hostname: 'db-01', osType: 'linux', siteId: 'site-1' },
];

const SUPPORTING_RESPONSES: Record<string, unknown> = {
  '/devices': { data: DEVICES, pagination: { page: 1, limit: 50, total: DEVICES.length } },
  '/orgs/sites': { data: [{ id: 'site-1', name: 'HQ' }], pagination: { page: 1, limit: 50, total: 1 } },
  '/policies': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
  '/scripts': { data: [], pagination: { page: 1, limit: 50, total: 0 } },
};

/**
 * Serves the group list plus the supporting endpoints. `writeResponse` stands in
 * for whatever the create/edit write returns, so a test can make the server
 * reject the submission.
 */
const serveGroups = (
  groups: unknown[],
  writeResponse?: Response,
  /**
   * Membership served by `GET /device-groups/:id/devices` — the authoritative
   * baseline the edit-mode chooser diffs against. A `Response` stands in for a
   * server that rejects the read.
   */
  membership: Record<string, string[]> | Response = {},
) => {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    const method = init?.method ?? 'GET';
    if (path === '/device-groups' && method === 'GET') {
      return jsonResponse({ data: groups, total: groups.length });
    }
    const memberMatch = /^\/device-groups\/([^/]+)\/devices$/.exec(path);
    if (memberMatch && method === 'GET') {
      if (!Array.isArray(membership) && 'ok' in membership) return membership as Response;
      const deviceIds = (membership as Record<string, string[]>)[memberMatch[1]] ?? [];
      return jsonResponse({
        data: deviceIds.map((deviceId) => ({ deviceId })),
        total: deviceIds.length,
      });
    }
    if (path.startsWith('/device-groups')) {
      return writeResponse ?? jsonResponse({ data: { id: 'new-group' } });
    }
    if (path in SUPPORTING_RESPONSES) return jsonResponse(SUPPORTING_RESPONSES[path]);
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  });
};

/** The request the page made with `method`, or undefined. */
const findWrite = (method: string) =>
  mockFetch.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === method,
  );

const parseBody = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;

/**
 * The membership chooser panel. Queries have to be scoped to it: a static
 * group's card lists the same hostnames, so a bare `getByText` is ambiguous
 * once the modal is open.
 */
const chooser = () => {
  const panel = screen
    .getByText('Manual Device Assignment')
    .closest('div.rounded-md');
  if (!panel) throw new Error('No membership chooser panel');
  return within(panel as HTMLElement);
};

/** The assignment checkbox on the chooser row naming `hostname`. */
const assignmentCheckbox = (hostname: string) => {
  const row = chooser().getByText(hostname).closest('label');
  if (!row) throw new Error(`No assignment row for ${hostname}`);
  const checkbox = row.querySelector('input[type="checkbox"]');
  if (!checkbox) throw new Error(`No checkbox for ${hostname}`);
  return checkbox as HTMLInputElement;
};

/** Ticks the assignment checkbox on the row naming `hostname`. */
const selectDevice = async (
  user: ReturnType<typeof userEvent.setup>,
  hostname: string,
) => {
  await user.click(assignmentCheckbox(hostname));
};

beforeEach(() => {
  vi.clearAllMocks();
  // A resolved focused-org scope: no fleet picker, create proceeds normally
  // (the injected ?orgId= supplies the owner).
  useOrgStore.setState({
    currentOrgId: 'org-focused',
    allOrgs: false,
    organizations: [
      {
        id: 'org-focused',
        partnerId: 'p-1',
        name: 'Focused Org',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
    organizationsLoaded: true,
    error: null,
  });
});

/**
 * Regression coverage for issue #3159: every static device-group creation from
 * this page failed with a 400, because the form sent an explicit
 * `filterConditions: null` that the API's create schema rejected while its
 * update schema accepted.
 */
describe('DeviceGroupsPage static groups', () => {
  describe('delete failures', () => {
    const GROUP = { id: 'group-1', name: 'Existing', type: 'static', deviceIds: [], deviceCount: 0 };

    it('shows the billing contracts from a 409 body in the delete modal', async () => {
      const user = userEvent.setup();
      serveGroups([GROUP], {
        ok: false,
        status: 409,
        json: async () => ({
          code: 'GROUP_IN_USE_BY_CONTRACTS',
          contractCount: 2,
          contracts: [
            { id: 'c1', name: 'Acme MSA', status: 'active' },
            { id: 'c2', name: 'Beta', status: 'draft' },
          ],
        }),
      } as unknown as Response);

      render(<DeviceGroupsPage />);
      await screen.findByText('Existing');
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await user.click(screen.getByRole('button', { name: 'Delete group' }));

      const expected = i18n.t('devices:deviceGroupsPage.billedByContracts', {
        count: 2,
        names: 'Acme MSA, Beta',
      });
      expect(await screen.findByText(expected)).toHaveRole('alert');
    });

    it('shows the count-only variant when the body has no contracts array, and the generic message for other failures', async () => {
      const user = userEvent.setup();
      serveGroups([GROUP], {
        ok: false,
        status: 409,
        json: async () => ({ code: 'GROUP_IN_USE_BY_CONTRACTS', contractCount: 1 }),
      } as unknown as Response);

      const { unmount } = render(<DeviceGroupsPage />);
      await screen.findByText('Existing');
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await user.click(screen.getByRole('button', { name: 'Delete group' }));
      expect(await screen.findByText(i18n.t('devices:deviceGroupsPage.billedByContractsCount', { count: 1 })))
        .toHaveRole('alert');

      unmount();
      vi.clearAllMocks();
      serveGroups([GROUP], {
        ok: false,
        status: 500,
        json: async () => ({}),
      } as unknown as Response);

      render(<DeviceGroupsPage />);
      await screen.findByText('Existing');
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      await user.click(screen.getByRole('button', { name: 'Delete group' }));
      expect(await screen.findByText(i18n.t('devices:deviceGroupsPage.failedToDeleteGroup'))).toHaveRole('alert');
    });
  });

  it('omits filterConditions and sends the selected devices when creating a static group', async () => {
    const user = userEvent.setup();
    serveGroups([{ id: 'group-1', name: 'Existing', type: 'static', deviceIds: [], deviceCount: 0 }]);

    render(<DeviceGroupsPage />);
    await screen.findByText('Existing');

    await user.click(screen.getByRole('button', { name: 'Create Group' }));
    await user.type(screen.getByPlaceholderText('e.g. Production Linux'), 'Cluster Hosts');
    await selectDevice(user, 'web-01');
    await user.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => expect(findWrite('POST')).toBeDefined());

    const post = findWrite('POST');
    // The literal path, not a translated string. This URL used to be read out
    // of the i18n catalog (`t("deviceGroupsPage.deviceGroups")`), so any locale
    // whose translator touched that entry would have posted somewhere else.
    expect(String(post?.[0])).toBe('/device-groups');

    const body = parseBody(post);
    expect(body.type).toBe('static');
    // The defect itself: a static create must NOT carry the key at all. Sending
    // `null` here is what produced "expected object, received null".
    expect(body).not.toHaveProperty('filterConditions');
    // And the devices the user picked have to reach the server — the create
    // schema silently stripped them, so the group came back empty.
    expect(body.deviceIds).toEqual(['device-1']);
  });

  it('sends the filter and no deviceIds when creating a dynamic group', async () => {
    const user = userEvent.setup();
    serveGroups([{ id: 'group-1', name: 'Existing', type: 'static', deviceIds: [], deviceCount: 0 }]);

    render(<DeviceGroupsPage />);
    await screen.findByText('Existing');

    await user.click(screen.getByRole('button', { name: 'Create Group' }));
    await user.type(screen.getByPlaceholderText('e.g. Production Linux'), 'Web Servers');
    await user.click(screen.getByRole('button', { name: 'Dynamic' }));
    await user.type(await screen.findByTestId('value-text-input'), 'web');
    await user.click(screen.getByRole('button', { name: 'Create group' }));

    await waitFor(() => expect(findWrite('POST')).toBeDefined());

    const body = parseBody(findWrite('POST'));
    expect(body.filterConditions).toEqual({
      operator: 'AND',
      conditions: [{ field: 'hostname', operator: 'contains', value: 'web' }],
    });
    // The create route rejects a non-empty device list on a dynamic group
    // rather than ignoring it, so the form must not send one.
    expect(body).not.toHaveProperty('deviceIds');
  });

  it("shows the server's validation message when a create is rejected", async () => {
    const user = userEvent.setup();
    serveGroups(
      [{ id: 'group-1', name: 'Existing', type: 'static', deviceIds: [], deviceCount: 0 }],
      {
        ok: false,
        status: 400,
        json: async () => ({
          error: 'filterConditions: Invalid input: expected object, received null',
        }),
      } as unknown as Response,
    );

    render(<DeviceGroupsPage />);
    await screen.findByText('Existing');

    await user.click(screen.getByRole('button', { name: 'Create Group' }));
    await user.type(screen.getByPlaceholderText('e.g. Production Linux'), 'Cluster Hosts');
    await user.click(screen.getByRole('button', { name: 'Create group' }));

    // The reporter had to open devtools to find this out: the handler threw a
    // fixed "Failed to save device group" and dropped the response body.
    expect(
      await screen.findByText(
        'filterConditions: Invalid input: expected object, received null',
      ),
    ).toBeInTheDocument();
  });

  it('sends an explicit null filterConditions when converting a dynamic group to static', async () => {
    const user = userEvent.setup();
    serveGroups([
      {
        id: 'group-1',
        name: 'Web Servers',
        type: 'dynamic',
        deviceCount: 2,
        filterConditions: {
          operator: 'AND',
          conditions: [{ field: 'hostname', operator: 'contains', value: 'web' }],
        },
      },
    ]);

    render(<DeviceGroupsPage />);
    await screen.findByText('Web Servers');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Static' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    // The update route is PATCH /:id (#3554 — the app used to send PUT, which
    // has no handler and 404s).
    await waitFor(() => expect(findWrite('PATCH')).toBeDefined());

    const body = parseBody(findWrite('PATCH'));
    // Unlike create, the update path MUST say `null` out loud: the API reads an
    // absent key as "leave the filter alone", which would strand the old filter
    // on a group the user just made static.
    expect(body.filterConditions).toBeNull();
    // Phantom fields are gone (#3554): no description column, no group policyId,
    // and membership isn't editable on update.
    expect(body.description).toBeUndefined();
    expect(body.policyId).toBeUndefined();
    expect(body.deviceIds).toBeUndefined();
  });

  // #3554: the form used to show Description and Policy Assignment controls that
  // the API silently dropped (no column / no group-policy field). They're gone.
  it('create form omits the phantom Description and Policy Assignment controls', async () => {
    const user = userEvent.setup();
    serveGroups([]);

    render(<DeviceGroupsPage />);
    await user.click(await screen.findByRole('button', { name: 'Create Group' }));

    expect(screen.queryByText('Description')).toBeNull();
    expect(screen.queryByText('Policy Assignment')).toBeNull();
    // The real static membership chooser is still offered on create.
    expect(screen.getByText('Manual Device Assignment')).toBeInTheDocument();
  });

  /**
   * Regression coverage for issue #3615: #3554 hid the membership chooser on
   * edit because `PATCH /:id` ignores `deviceIds`. The capability was on the API
   * all along under `POST /:id/devices` and `DELETE /:id/devices/:deviceId` — it
   * was simply never wired, so static membership was uneditable from the UI.
   */
  describe('editing static membership', () => {
    const STATIC_GROUP = {
      id: 'group-1',
      name: 'Web Servers',
      type: 'static',
      deviceCount: 1,
      deviceIds: ['device-1'],
    };

    it('offers the chooser on edit, seeded from the group membership endpoint', async () => {
      const user = userEvent.setup();
      serveGroups([STATIC_GROUP], undefined, { 'group-1': ['device-2'] });

      render(<DeviceGroupsPage />);
      await screen.findByText('Web Servers');
      await user.click(screen.getByRole('button', { name: 'Edit' }));

      expect(await screen.findByText('Manual Device Assignment')).toBeInTheDocument();

      // Seeded from GET /:id/devices, NOT from the list row's `deviceIds`
      // (device-1). The save diff issues DELETEs, so a stale baseline would drop
      // devices the user never deselected.
      await waitFor(() => expect(assignmentCheckbox('db-01')).toBeChecked());
      expect(assignmentCheckbox('web-01')).not.toBeChecked();
    });

    it('sends the added and removed devices to the membership endpoints, never in the PATCH', async () => {
      const user = userEvent.setup();
      serveGroups([STATIC_GROUP], undefined, { 'group-1': ['device-2'] });

      render(<DeviceGroupsPage />);
      await screen.findByText('Web Servers');
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await screen.findByText('Manual Device Assignment');
      await waitFor(() => expect(assignmentCheckbox('db-01')).toBeChecked());

      await selectDevice(user, 'web-01'); // add device-1
      await selectDevice(user, 'db-01'); // remove device-2
      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(findWrite('POST')).toBeDefined());

      // Membership is not part of the group's definition — the PATCH route has
      // no `deviceIds` field, so folding it in there is a silent no-op (#3554).
      const patch = findWrite('PATCH');
      expect(parseBody(patch)).not.toHaveProperty('deviceIds');

      const post = findWrite('POST');
      expect(String(post?.[0])).toBe('/device-groups/group-1/devices');
      expect(parseBody(post).deviceIds).toEqual(['device-1']);

      // Removal is path-param style and one call per device — the API offers no
      // bulk-remove verb.
      const deletes = mockFetch.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deletes.map((call) => String(call[0]))).toEqual([
        '/device-groups/group-1/devices/device-2',
      ]);
    });

    it('issues no membership calls when the selection is unchanged', async () => {
      const user = userEvent.setup();
      serveGroups([STATIC_GROUP], undefined, { 'group-1': ['device-2'] });

      render(<DeviceGroupsPage />);
      await screen.findByText('Web Servers');
      await user.click(screen.getByRole('button', { name: 'Edit' }));
      await screen.findByText('Manual Device Assignment');
      await waitFor(() => expect(assignmentCheckbox('db-01')).toBeChecked());

      await user.click(screen.getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(findWrite('PATCH')).toBeDefined());
      expect(findWrite('POST')).toBeUndefined();
      expect(findWrite('DELETE')).toBeUndefined();
    });

    it('disables the chooser and the save when the membership read fails', async () => {
      const user = userEvent.setup();
      serveGroups([STATIC_GROUP], undefined, {
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
      } as unknown as Response);

      render(<DeviceGroupsPage />);
      await screen.findByText('Web Servers');
      await user.click(screen.getByRole('button', { name: 'Edit' }));

      // Without a trustworthy baseline the diff would be a guess, so the form
      // says so rather than rendering a chooser that misreports membership.
      expect(
        await screen.findByText('Failed to load group membership'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    });

    it('ignores a membership read that resolves after the user moved to another group', async () => {
      const user = userEvent.setup();
      const groups = [
        { ...STATIC_GROUP, id: 'group-a', name: 'Group A', deviceIds: [] },
        { ...STATIC_GROUP, id: 'group-b', name: 'Group B', deviceIds: [] },
      ];
      const membership: Record<string, string[]> = {
        'group-a': ['device-1'],
        'group-b': ['device-2'],
      };

      // Group A's read hangs until `releaseA()`, so it can be made to land after
      // the user has already opened Group B.
      let releaseA = () => {};
      const aPending = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const path = String(url).split('?')[0];
        const method = init?.method ?? 'GET';
        if (path === '/device-groups' && method === 'GET') {
          return jsonResponse({ data: groups, total: groups.length });
        }
        const memberMatch = /^\/device-groups\/([^/]+)\/devices$/.exec(path);
        if (memberMatch && method === 'GET') {
          const groupId = memberMatch[1];
          if (groupId === 'group-a') await aPending;
          const deviceIds = membership[groupId] ?? [];
          return jsonResponse({
            data: deviceIds.map((deviceId) => ({ deviceId })),
            total: deviceIds.length,
          });
        }
        if (path.startsWith('/device-groups')) {
          return jsonResponse({ data: { id: 'group-b' } });
        }
        if (path in SUPPORTING_RESPONSES) return jsonResponse(SUPPORTING_RESPONSES[path]);
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      });

      render(<DeviceGroupsPage />);
      await screen.findByText('Group A');

      const editButtons = screen.getAllByRole('button', { name: 'Edit' });
      await user.click(editButtons[0]); // Group A — read hangs
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      await user.click(screen.getAllByRole('button', { name: 'Edit' })[1]); // Group B

      await waitFor(() => expect(assignmentCheckbox('db-01')).toBeChecked());

      releaseA();
      await waitFor(() => expect(assignmentCheckbox('db-01')).toBeChecked());
      // Group A's late answer must not install itself as Group B's baseline:
      // saving an untouched Group B would then remove device-2 and add
      // device-1 — devices moved between groups purely on request timing.
      expect(assignmentCheckbox('web-01')).not.toBeChecked();

      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(findWrite('PATCH')).toBeDefined());
      expect(findWrite('POST')).toBeUndefined();
      expect(findWrite('DELETE')).toBeUndefined();
    });
  });
});
