import '@/lib/i18n';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import DeviceGroupsPage from './DeviceGroupsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
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
const serveGroups = (groups: unknown[], writeResponse?: Response) => {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    const method = init?.method ?? 'GET';
    if (path === '/device-groups' && method === 'GET') {
      return jsonResponse({ data: groups, total: groups.length });
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

/** Ticks the assignment checkbox on the row naming `hostname`. */
const selectDevice = async (
  user: ReturnType<typeof userEvent.setup>,
  hostname: string,
) => {
  const row = screen.getByText(hostname).closest('label');
  if (!row) throw new Error(`No assignment row for ${hostname}`);
  const checkbox = row.querySelector('input[type="checkbox"]');
  if (!checkbox) throw new Error(`No checkbox for ${hostname}`);
  await user.click(checkbox);
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Regression coverage for issue #3159: every static device-group creation from
 * this page failed with a 400, because the form sent an explicit
 * `filterConditions: null` that the API's create schema rejected while its
 * update schema accepted.
 */
describe('DeviceGroupsPage static groups', () => {
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

  it('hides the static device chooser on edit (membership is not editable there)', async () => {
    const user = userEvent.setup();
    serveGroups([
      { id: 'group-1', name: 'Web Servers', type: 'static', deviceCount: 1, deviceIds: ['device-1'] },
    ]);

    render(<DeviceGroupsPage />);
    await screen.findByText('Web Servers');
    await user.click(screen.getByRole('button', { name: 'Edit' }));

    // Editing a static group must not present a membership chooser that a PATCH
    // would silently ignore — it's create-only now.
    expect(screen.queryByText('Manual Device Assignment')).toBeNull();
  });
});
