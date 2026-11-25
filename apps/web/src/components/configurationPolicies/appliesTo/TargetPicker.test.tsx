import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));

import TargetPicker from './TargetPicker';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GROUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MSP_GROUP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DEVICE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const urls = () => fetchWithAuth.mock.calls.map((c) => String(c[0]));

function serve() {
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.startsWith('/orgs/organizations')) return jsonResponse({ data: [{ id: ORG, name: 'Acme' }, { id: ORG2, name: 'Birch' }] });
    if (url.startsWith('/orgs/sites')) return jsonResponse({ data: [{ id: SITE, name: 'HQ' }] });
    if (url.startsWith('/device-groups') && url.includes('ownerScope=partner')) return jsonResponse({ data: [{ id: MSP_GROUP, name: 'All servers' }] });
    if (url.startsWith('/device-groups')) return jsonResponse({ data: [{ id: GROUP, name: 'Laptops' }] });
    if (url.startsWith('/devices')) return jsonResponse({ data: [{ id: DEVICE, hostname: 'PC-1', siteName: 'HQ' }] });
    return jsonResponse({ data: [] });
  });
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchWithAuth.mockReset();
  serve();
});

describe('TargetPicker', () => {
  it("an org-managed policy's picker only queries its own organization", async () => {
    const onPick = vi.fn();
    render(<TargetPicker owner={{ kind: 'org', orgId: ORG, orgName: 'Acme' }} onPick={onPick} />);

    // Organization: the owning org, locked, no organization search.
    fireEvent.click(screen.getByTestId('target-picker-level-organization'));
    fireEvent.click(await screen.findByTestId(`target-picker-option-${ORG}`));
    expect(onPick).toHaveBeenLastCalledWith({ level: 'organization', targetId: ORG, name: 'Acme' });

    for (const level of ['site', 'device_group', 'device'] as const) {
      fireEvent.click(screen.getByTestId(`target-picker-level-${level}`));
      fireEvent.change(screen.getByTestId('target-picker-search'), { target: { value: `q-${level}` } });
      await waitFor(() => expect(urls().some((u) => u.includes(`search=q-${level}`))).toBe(true));
    }
    expect(urls().length).toBeGreaterThanOrEqual(3);
    for (const url of urls()) {
      expect(url).toContain(`orgId=${ORG}`);
      expect(url).not.toContain('ownerScope=partner');
      expect(url.startsWith('/orgs/organizations')).toBe(false);
    }
  });

  it('MSP-owned groups are offered only on an MSP-managed policy', async () => {
    const { unmount } = render(<TargetPicker owner={{ kind: 'org', orgId: ORG, orgName: 'Acme' }} onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('target-picker-level-device_group'));
    expect(await screen.findByTestId(`target-picker-option-${GROUP}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`target-picker-option-${MSP_GROUP}`)).toBeNull();
    expect(urls().some((u) => u.includes('ownerScope=partner'))).toBe(false);
    unmount();

    fetchWithAuth.mockClear();
    const onPick = vi.fn();
    render(<TargetPicker owner={{ kind: 'msp' }} onPick={onPick} />);
    fireEvent.click(screen.getByTestId('target-picker-level-device_group'));
    fireEvent.click(await screen.findByTestId(`target-picker-option-${MSP_GROUP}`));
    expect(onPick).toHaveBeenLastCalledWith({ level: 'device_group', targetId: MSP_GROUP, name: 'All servers' });
    const partnerCall = fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('ownerScope=partner'));
    expect(partnerCall?.[1]).toEqual(expect.objectContaining({ skipOrgIdInjection: true }));
  });

  it('an MSP-managed policy drills down from an organization to its sites, groups and devices', async () => {
    const onPick = vi.fn();
    render(<TargetPicker owner={{ kind: 'msp' }} onPick={onPick} />);
    fireEvent.click(screen.getByTestId('target-picker-level-site'));
    // Step one: choose the organization.
    fireEvent.click(await screen.findByTestId(`target-picker-org-${ORG2}`));
    fireEvent.click(await screen.findByTestId(`target-picker-option-${SITE}`));
    expect(onPick).toHaveBeenLastCalledWith({ level: 'site', targetId: SITE, name: 'HQ' });
    expect(urls().some((u) => u.startsWith('/orgs/sites') && u.includes(`orgId=${ORG2}`))).toBe(true);
    // The organization list never takes the switcher's org.
    const orgCall = fetchWithAuth.mock.calls.find((c) => String(c[0]).startsWith('/orgs/organizations'));
    expect(orgCall?.[1]).toEqual(expect.objectContaining({ skipOrgIdInjection: true }));
  });

  it('search hits the server with the query', async () => {
    render(<TargetPicker owner={{ kind: 'msp' }} onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('target-picker-level-organization'));
    await screen.findByTestId(`target-picker-option-${ORG}`);
    fetchWithAuth.mockClear();
    fireEvent.change(screen.getByTestId('target-picker-search'), { target: { value: 'birch & co' } });
    await waitFor(() =>
      expect(urls().some((u) => u.startsWith('/orgs/organizations') && u.includes('search=birch+%26+co'))).toBe(true),
    );
  });

  it('a device option shows its site', async () => {
    render(<TargetPicker owner={{ kind: 'org', orgId: ORG, orgName: 'Acme' }} onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('target-picker-level-device'));
    const option = await screen.findByTestId(`target-picker-option-${DEVICE}`);
    expect(option).toHaveTextContent('PC-1');
    expect(option).toHaveTextContent('HQ');
  });

  it('a target already listed cannot be picked twice', async () => {
    render(
      <TargetPicker
        owner={{ kind: 'org', orgId: ORG, orgName: 'Acme' }}
        onPick={vi.fn()}
        isListed={(level, id) => level === 'site' && id === SITE}
      />,
    );
    fireEvent.click(screen.getByTestId('target-picker-level-site'));
    expect(await screen.findByTestId(`target-picker-option-${SITE}`)).toBeDisabled();
  });

  it('a failed search says so instead of showing no results', async () => {
    fetchWithAuth.mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    render(<TargetPicker owner={{ kind: 'org', orgId: ORG, orgName: 'Acme' }} onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('target-picker-level-site'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('switching level never leaves the old level’s results clickable', async () => {
    render(<TargetPicker owner={{ kind: 'org', orgId: ORG, orgName: 'Acme' }} onPick={vi.fn()} />);
    fireEvent.click(screen.getByTestId('target-picker-level-site'));
    await screen.findByTestId(`target-picker-option-${SITE}`);
    // The device list is slow to answer.
    fetchWithAuth.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByTestId('target-picker-level-device'));
    expect(screen.queryByTestId(`target-picker-option-${SITE}`)).toBeNull();
  });

  it('nothing can be picked while disabled', async () => {
    render(<TargetPicker owner={{ kind: 'org', orgId: ORG, orgName: 'Acme' }} onPick={vi.fn()} disabled />);
    fireEvent.click(screen.getByTestId('target-picker-level-site'));
    expect(await screen.findByTestId(`target-picker-option-${SITE}`)).toBeDisabled();
  });
});
