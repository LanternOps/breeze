const setPageContext = vi.hoisted(() => vi.fn());
vi.mock('@/stores/aiStore', () => ({ useAiStore: (select: (s: unknown) => unknown) => select({ setPageContext }) }));
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SiteDetailPage from './SiteDetailPage';
import { decodeFilterFromHash } from '../devices/filterUrl';
import { readDeviceClassFromHash } from '../devices/deviceClassFilter';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const granted = vi.hoisted(() => new Set<string>());
const flags = vi.hoisted(() => ({ ENABLE_ENDPOINT_MESSAGING: true }));
vi.mock('../../lib/featureFlags', async (orig) => ({
  ...(await orig<typeof import('../../lib/featureFlags')>()),
  get ENABLE_ENDPOINT_MESSAGING() { return flags.ENABLE_ENDPOINT_MESSAGING; },
}));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => granted.has(`${r}:${a}`) }),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchMock = vi.mocked(fetchWithAuth);

const SITE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ORG_ID = '11111111-2222-4333-8444-555566667777';

// The API stores address/contact as nested JSONB. Saving must round-trip that
// shape — a flat payload gets silently stripped by the route's Zod validation,
// which made the form appear to reset on save (the bug this test guards).
const SITE_FROM_API = {
  id: SITE_ID,
  orgId: ORG_ID,
  name: 'Main Office',
  // Deliberately a zone that NEITHER legacy hardcoded list contained (issue
  // #2856): the old <select> here had no matching <option>, so the browser
  // silently fell back to its first one and a save rewrote the site to UTC.
  timezone: 'Pacific/Chatham',
  status: 'active',
  address: {
    line1: '123 Market Street',
    line2: 'Suite 500',
    city: 'San Francisco',
    state: 'CA',
    postalCode: '94107',
    country: 'United States'
  },
  contact: {
    name: 'Alex Morgan',
    email: 'alex@company.com',
    phone: '+1 (555) 123-4567'
  }
};

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

function mockApi() {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method;

    if (url === `/orgs/sites/${SITE_ID}` && method === 'PATCH') {
      // Echo the request body back as the persisted row (it is already nested).
      return makeJsonResponse(JSON.parse(String(init?.body)));
    }
    if (url === `/orgs/sites/${SITE_ID}`) {
      return makeJsonResponse(SITE_FROM_API);
    }
    if (url === `/orgs/organizations/${ORG_ID}`) {
      return makeJsonResponse({ id: ORG_ID, name: 'Acme Corp' });
    }
    // Policy assignments / available policies fired on mount.
    return makeJsonResponse({ data: [] });
  });
}

describe('SiteDetailPage — address/contact round-trip', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    window.location.hash = '';
  });

  it('populates the form from the nested address/contact the API returns', async () => {
    mockApi();
    render(<SiteDetailPage siteId={SITE_ID} />);

    // If populateForm wrongly read flat keys, these would all be empty.
    expect(await screen.findByPlaceholderText('123 Market Street')).toHaveValue('123 Market Street');
    expect(screen.getByPlaceholderText('San Francisco')).toHaveValue('San Francisco');
    expect(setPageContext).toHaveBeenCalledWith(expect.objectContaining({ type: 'record', kind: 'site', id: SITE_ID }));
    expect(screen.getByPlaceholderText('CA')).toHaveValue('CA');
    expect(screen.getByPlaceholderText('Alex Morgan')).toHaveValue('Alex Morgan');
    expect(screen.getByPlaceholderText('alex@company.com')).toHaveValue('alex@company.com');
  });

  it('gives the icon-only back link an accessible name and returns to the Sites page (#7158 a11y, #9794)', async () => {
    mockApi();
    render(<SiteDetailPage siteId={SITE_ID} />);

    expect(await screen.findByRole('link', { name: 'Back to sites' })).toHaveAttribute('href', '/settings/sites');
    expect(screen.queryByRole('link', { name: 'Back to organizations' })).toBeNull();
  });

  it('breadcrumbs read Settings → Sites → site, and the org name still links to its record (#9794)', async () => {
    mockApi();
    render(<SiteDetailPage siteId={SITE_ID} />);

    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    await waitFor(() => expect(crumbs).toHaveTextContent('Main Office'));
    const links = within(crumbs).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Settings', '/settings'],
      ['Sites', '/settings/sites'],
    ]);
    expect(crumbs).not.toHaveTextContent('Organizations');
    expect(await screen.findByTestId('site-detail-org-link')).toHaveAttribute('href', `/organizations/${ORG_ID}`);
  });

  it('the not-found state also returns to the Sites page (#9794)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'nope' }, false));
    render(<SiteDetailPage siteId={SITE_ID} />);

    expect(await screen.findByRole('link', { name: 'Back to sites' })).toHaveAttribute('href', '/settings/sites');
  });

  it('links the site name input to its label (#7158 a11y)', async () => {
    mockApi();
    render(<SiteDetailPage siteId={SITE_ID} />);

    expect(await screen.findByLabelText('Site name')).toHaveValue('Main Office');
  });

  it('confirms a successful save with a toast (#5313)', async () => {
    mockApi();
    vi.mocked(showToast).mockClear();
    render(<SiteDetailPage siteId={SITE_ID} />);
    fireEvent.change(await screen.findByPlaceholderText('San Francisco'), { target: { value: 'Oakland' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }))
    );
  });

  it('PATCHes a nested address/contact payload (not flat keys) on save', async () => {
    mockApi();
    render(<SiteDetailPage siteId={SITE_ID} />);

    const cityInput = await screen.findByPlaceholderText('San Francisco');
    fireEvent.change(cityInput, { target: { value: 'Oakland' } });

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === `/orgs/sites/${SITE_ID}` && init?.method === 'PATCH'
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String(patchCall![1]?.body));

      // The route's Zod schema accepts nested `address`/`contact` and strips
      // anything else — so the payload must be nested.
      expect(body.address).toEqual({
        line1: '123 Market Street',
        line2: 'Suite 500',
        city: 'Oakland',
        state: 'CA',
        postalCode: '94107',
        country: 'United States'
      });
      expect(body.contact).toEqual({
        name: 'Alex Morgan',
        email: 'alex@company.com',
        phone: '+1 (555) 123-4567'
      });
      // No flat keys that the API would silently drop.
      expect(body).not.toHaveProperty('addressLine1');
      expect(body).not.toHaveProperty('city');
      expect(body).not.toHaveProperty('contactName');
    });
  });

  it('renders a stored zone the old hardcoded list lacked, and round-trips it untouched', async () => {
    mockApi();
    render(<SiteDetailPage siteId={SITE_ID} />);

    const trigger = await screen.findByTestId('site-detail-timezone-trigger');
    expect(trigger).toHaveTextContent('Pacific/Chatham');

    // Save after editing an UNRELATED field: the zone the user never touched
    // must survive rather than being rewritten to the picker's first option.
    fireEvent.change(screen.getByPlaceholderText('San Francisco'), { target: { value: 'Oakland' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === `/orgs/sites/${SITE_ID}` && init?.method === 'PATCH'
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(String(patchCall![1]?.body)).timezone).toBe('Pacific/Chatham');
    });
  });

  it('links the primary-contact editor to the organization contact list (#3258 W04)', async () => {
    mockApi();
    render(<SiteDetailPage siteId={SITE_ID} />);

    const link = await screen.findByTestId('site-detail-all-contacts-link');
    // The full list lives on the org settings Contacts tab; this editor still
    // writes the site's single primary through the compatibility projection.
    expect(link).toHaveAttribute('href', `/settings/organizations/${ORG_ID}#contacts`);
  });

  it('marks the form dirty and PATCHes a newly picked zone', async () => {
    mockApi();
    render(<SiteDetailPage siteId={SITE_ID} />);

    // The value-based onChange is a different handler from the event-based one
    // the other fields use; wiring the event handler here would PATCH
    // `timezone: undefined` and leave Save disabled.
    fireEvent.click(await screen.findByTestId('site-detail-timezone-trigger'));
    fireEvent.change(screen.getByTestId('site-detail-timezone-search'), { target: { value: 'paris' } });
    fireEvent.click(screen.getByTestId('site-detail-timezone-option-Europe/Paris'));

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === `/orgs/sites/${SITE_ID}` && init?.method === 'PATCH'
      );
      expect(patchCall).toBeTruthy();
      expect(JSON.parse(String(patchCall![1]?.body)).timezone).toBe('Europe/Paris');
    });
  });

  it('hides Send message without endpoint_messages:send, shows it with the permission', async () => {
    mockApi();
    granted.clear();
    const { unmount } = render(<SiteDetailPage siteId={SITE_ID} />);
    await screen.findByPlaceholderText('123 Market Street');
    expect(screen.queryByTestId('site-send-message')).toBeNull();
    unmount();

    granted.add('endpoint_messages:send');
    render(<SiteDetailPage siteId={SITE_ID} />);
    expect(await screen.findByTestId('site-send-message')).toBeTruthy();
  });

  // #8968: hidden until the build enables endpoint messaging.
  it('hides Send message when the build-time endpoint messaging flag is off', async () => {
    flags.ENABLE_ENDPOINT_MESSAGING = false;
    try {
      mockApi();
      granted.clear();
      granted.add('endpoint_messages:send');
      render(<SiteDetailPage siteId={SITE_ID} />);
      await screen.findByPlaceholderText('123 Market Street');
      expect(screen.queryByTestId('site-send-message')).toBeNull();
    } finally {
      flags.ENABLE_ENDPOINT_MESSAGING = true;
    }
  });
});

describe('SiteDetailPage — devices tab count + site-filtered "View all" (#9791)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    granted.clear();
    window.location.hash = '#devices';
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `/orgs/sites/${SITE_ID}`) return makeJsonResponse({ ...SITE_FROM_API, deviceCount: 7 });
      if (url === `/orgs/organizations/${ORG_ID}`) return makeJsonResponse({ id: ORG_ID, name: 'Acme Corp' });
      return makeJsonResponse({ data: [] });
    });
  });

  it('renders the device count the API returned', async () => {
    render(<SiteDetailPage siteId={SITE_ID} />);
    const count = await screen.findByTestId('site-detail-device-count');
    expect(count.textContent).toBe('7');
  });

  it('"View all" opens the devices list pinned to this org, agent class, and this site', async () => {
    render(<SiteDetailPage siteId={SITE_ID} />);
    const link = await screen.findByTestId('site-detail-devices-view-all-link');
    const href = link.getAttribute('href')!;
    expect(href.startsWith(`/devices#orgId=${ORG_ID}&deviceClass=agent&filtersV2=`)).toBe(true);
    const hash = href.slice(href.indexOf('#'));
    expect(decodeFilterFromHash(hash)).toEqual({
      operator: 'AND',
      conditions: [{ field: 'siteId', operator: 'equals', value: SITE_ID }],
    });
    expect(readDeviceClassFromHash(hash)).toBe('agent');
  });

  it('renders no "View all" link when the org id is not a uuid (never a broader fallback link)', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === `/orgs/sites/${SITE_ID}`) return makeJsonResponse({ ...SITE_FROM_API, orgId: 'not-a-uuid', deviceCount: 7 });
      return makeJsonResponse({ data: [] });
    });
    render(<SiteDetailPage siteId={SITE_ID} />);
    await screen.findByTestId('site-detail-device-count');
    expect(screen.queryByTestId('site-detail-devices-view-all-link')).toBeNull();
  });

  it('link has a resting underline and a focus-visible ring', async () => {
    render(<SiteDetailPage siteId={SITE_ID} />);
    const cls = (await screen.findByTestId('site-detail-devices-view-all-link')).className;
    expect(cls).toMatch(/underline/);
    expect(cls).toMatch(/focus-visible:ring/);
  });
});
