import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../../shared/Toast';
import { i18n } from '@/lib/i18n';
import CopyPolicyDialog from './CopyPolicyDialog';

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

const ACME = { id: 'org-acme', name: 'Acme' };
const BIRCH = { id: 'org-birch', name: 'Birch' };

type Route = (url: string, body: Record<string, unknown> | null) => Response | undefined;
let route: Route;
const copyBodies = () =>
  fetchMock.mock.calls
    .filter(([url, init]) => String(url).endsWith('/copy') && (init as RequestInit | undefined)?.method === 'POST')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(navigateTo).mockReset();
  route = () => undefined;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const answer = route(String(url), body);
    if (answer) return answer;
    if (String(url).includes('/eligible-parents')) return res(200, { data: [] });
    if (String(url).endsWith('/copy') && body?.dryRun) return res(200, { dryRun: true, carried: [], dropped: [] });
    return res(500, { error: 'unexpected' });
  });
});
afterEach(cleanup);

function open(props: Partial<React.ComponentProps<typeof CopyPolicyDialog>> = {}) {
  const onClose = vi.fn();
  render(
    <CopyPolicyDialog
      open
      onClose={onClose}
      source={{ id: 'pol-1', name: 'Workstations', orgId: null, parentPolicyId: null }}
      organizations={[ACME, BIRCH]}
      currentOrgId={ACME.id}
      creator="full_partner"
      {...props}
    />,
  );
  return { onClose };
}

describe('CopyPolicyDialog', () => {
  it('Copy shows what will not be carried before it copies', async () => {
    route = (url, body) =>
      url.endsWith('/copy') && body?.dryRun
        ? res(200, {
            dryRun: true,
            carried: ['patch'],
            dropped: [
              { featureType: 'onedrive_helper', reason: 'org_only_feature' },
              { featureType: 'software_policy', reason: 'linked_item_unavailable' },
            ],
          })
        : undefined;

    open();

    const dropped = await screen.findByTestId('config-policy-copy-dropped');
    expect(dropped).toHaveTextContent('OneDrive Helper');
    expect(dropped).toHaveTextContent(i18n.t('policies:configurationPolicies.copyPolicy.reasons.org_only_feature'));
    expect(dropped).toHaveTextContent(i18n.t('policies:configurationPolicies.copyPolicy.reasons.linked_item_unavailable'));
    expect(screen.getByTestId('config-policy-copy-carried')).toHaveTextContent('Patches');
    // Only the dry run has been sent: nothing is copied until the user confirms.
    expect(copyBodies()).toEqual([
      { name: 'Workstations (copy)', ownerScope: 'partner', parentPolicyId: null, dryRun: true },
    ]);
  });

  it('Copy lands on the new inactive policy', async () => {
    route = (url, body) =>
      url.endsWith('/copy') && body && !body.dryRun
        ? res(201, { dryRun: false, policyId: 'pol-new', orgId: null, dropped: [] })
        : undefined;
    open();
    await screen.findByTestId('config-policy-copy-carried');

    fireEvent.change(screen.getByTestId('config-policy-copy-name'), { target: { value: 'Servers' } });
    fireEvent.click(screen.getByTestId('config-policy-copy-confirm'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/configuration-policies/pol-new'));
    expect(copyBodies().at(-1)).toEqual({ name: 'Servers', ownerScope: 'partner', parentPolicyId: null });
  });

  it('copies to an organization the user picks, and checks again for it', async () => {
    open();
    await screen.findByTestId('config-policy-copy-carried');

    fireEvent.change(screen.getByTestId('config-policy-copy-owner'), { target: { value: BIRCH.id } });

    await waitFor(() =>
      expect(copyBodies().at(-1)).toEqual({
        name: 'Workstations (copy)', ownerScope: 'organization', orgId: BIRCH.id, parentPolicyId: null, dryRun: true,
      }),
    );
  });

  it('OneDrive Helper on an MSP-managed policy starts the copy at one organization', async () => {
    open({ initialOwner: 'organization' });
    await waitFor(() =>
      expect(copyBodies()[0]).toMatchObject({ ownerScope: 'organization', orgId: ACME.id, dryRun: true }),
    );
    expect(screen.getByTestId('config-policy-copy-owner')).toHaveValue(ACME.id);
  });

  it('an organization user copies into its own organization only', async () => {
    open({ creator: 'org', source: { id: 'pol-1', name: 'MSP baseline', orgId: null, parentPolicyId: null } });
    await screen.findByTestId('config-policy-copy-carried');
    expect(screen.queryByTestId('config-policy-copy-owner')).toBeNull();
    expect(copyBodies()[0]).toMatchObject({ ownerScope: 'organization', orgId: ACME.id });
  });

  it('a refused dry run says why and offers no Copy', async () => {
    route = (url, body) =>
      url.endsWith('/copy') && body?.dryRun ? res(403, { error: 'x', code: 'HP_CMSL_EXECUTE_REQUIRED' }) : undefined;
    open();

    expect(await screen.findByTestId('config-policy-copy-preview-error')).toHaveTextContent(
      i18n.t('policies:configurationPolicies.copyPolicy.executeRequired'),
    );
    expect(screen.getByTestId('config-policy-copy-confirm')).toBeDisabled();
  });

  it('says so when the real copy left behind more than the check showed', async () => {
    route = (url, body) =>
      url.endsWith('/copy') && body && !body.dryRun
        ? res(201, { dryRun: false, policyId: 'pol-new', orgId: null, dropped: [{ featureType: 'monitors', reason: 'linked_item_unavailable' }] })
        : undefined;
    open();
    await screen.findByTestId('config-policy-copy-carried');
    fireEvent.click(screen.getByTestId('config-policy-copy-confirm'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/configuration-policies/pol-new'));
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning', message: expect.stringContaining('Monitors') }));
  });

  it('Copy stays off until the check for the owner now chosen has answered', async () => {
    let release: (r: Response) => void = () => {};
    open();
    await screen.findByTestId('config-policy-copy-carried');
    expect(screen.getByTestId('config-policy-copy-confirm')).toBeEnabled();

    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { release = resolve; }));
    fireEvent.change(screen.getByTestId('config-policy-copy-owner'), { target: { value: BIRCH.id } });
    expect(screen.getByTestId('config-policy-copy-confirm')).toBeDisabled();

    release(res(200, { dryRun: true, carried: ['patch'], dropped: [] }));
    await waitFor(() => expect(screen.getByTestId('config-policy-copy-confirm')).toBeEnabled());
  });

  it('keeps the source\'s parent for the same owner and clears it for another', async () => {
    open({ source: { id: 'pol-1', name: 'Desks', orgId: ACME.id, parentPolicyId: 'parent-1' } });
    await waitFor(() => expect(copyBodies()[0]).toMatchObject({ ownerScope: 'organization', orgId: ACME.id, parentPolicyId: 'parent-1' }));

    fireEvent.change(screen.getByTestId('config-policy-copy-owner'), { target: { value: BIRCH.id } });
    await waitFor(() => expect(copyBodies().at(-1)).toMatchObject({ orgId: BIRCH.id, parentPolicyId: null }));
  });
});
