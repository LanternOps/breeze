import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DirectoryDeprovisioningPanel } from './DirectoryDeprovisioningPanel';
import type { PortalDirectoryActionRow, PortalDirectoryRunSummary, PortalDirectoryStatusView } from './types';

const fetchWithAuthMock = vi.fn();
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToastMock = vi.fn();
vi.mock('../../shared/Toast', () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));
// Every mutation goes through runAction (no-silent-mutations): spy on it, keep its behaviour.
const runActionSpy = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/runAction', async (orig) => {
  const actual = await orig<typeof import('@/lib/runAction')>();
  return {
    ...actual,
    runAction: (...a: Parameters<typeof actual.runAction>) => { runActionSpy.calls += 1; return actual.runAction(...a); },
  };
});

const ORG = '11111111-1111-4111-8111-111111111111';
const STATUS = `/orgs/organizations/${ORG}/portal-directory`;
const DIGEST = 'a'.repeat(64);
const BOTH = { microsoft: true, google: true };

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  }));
}

function run(over: Partial<PortalDirectoryRunSummary> = {}): PortalDirectoryRunSummary {
  return {
    id: 'run-1', outcome: 'evaluated', reason: null, disposition: 'reported', holdReason: null,
    directoryUserCount: 120, usableCount: 40, affectedCount: 1, impactDigest: DIGEST,
    createdAt: '2026-11-14T10:00:00.000Z', ...over,
  };
}

function action(over: Partial<PortalDirectoryActionRow> = {}): PortalDirectoryActionRow {
  return {
    id: 'act-1', runId: 'run-1', identityId: 'ident-1', portalUserId: 'pu-1', email: 'leaver@customer.example',
    name: 'Pat Leaver', provider: 'entra', reason: 'account_disabled', effect: 'identity_and_account',
    keepsPassword: false, status: 'reported', rearmed: false, ...over,
  };
}

function view(over: Partial<PortalDirectoryStatusView> = {}): PortalDirectoryStatusView {
  return {
    mode: 'report',
    sources: [
      { source: 'entra', lastRun: run(), lastEvaluatedRun: run() },
      { source: 'google', lastRun: null, lastEvaluatedRun: null },
    ],
    openActions: [action()],
    ...over,
  };
}

function mockStatus(v: PortalDirectoryStatusView, extra?: (url: string, init?: RequestInit) => Promise<Response> | undefined) {
  fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url === STATUS && (!init?.method || init.method === 'GET')) return json({ data: v });
    return json({ error: 'unexpected' }, 500);
  });
}

const posts = () => fetchWithAuthMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

describe('DirectoryDeprovisioningPanel', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    showToastMock.mockReset();
    runActionSpy.calls = 0;
  });

  it('report mode shows the report-only line and the planned actions, with no Apply button', async () => {
    mockStatus(view());
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={BOTH} />);
    const panel = await screen.findByTestId('portal-directory-panel');
    expect(within(panel).getByTestId('portal-directory-mode')).toHaveTextContent('Report only: nobody is disabled automatically yet');
    const row = within(panel).getByTestId('portal-directory-action-ident-1');
    expect(row).toHaveTextContent('Pat Leaver');
    expect(row).toHaveTextContent('Microsoft');
    expect(row).toHaveTextContent('Disabled in the directory');
    expect(row).toHaveTextContent('Disables the account');
    expect(within(panel).getByTestId('portal-directory-source-google')).toHaveTextContent('No directory read yet');
    expect(within(panel).queryByTestId('portal-directory-apply-entra')).toBeNull();
    expect(within(panel).queryByTestId('portal-directory-dismiss-entra')).toBeNull();
  });

  it('a held run shows Apply and Dismiss with the count, hold reason and digest', async () => {
    const held = run({ disposition: 'held', holdReason: 'first_enforcement', affectedCount: 1 });
    mockStatus(
      view({ mode: 'enforce', sources: [{ source: 'entra', lastRun: held, lastEvaluatedRun: held }, { source: 'google', lastRun: null, lastEvaluatedRun: null }], openActions: [action({ status: 'held' })] }),
      (url, init) => (init?.method === 'POST' && url === `${STATUS}/runs/run-1/apply` ? json({ data: { runId: 'run-1', status: 'applying', actions: 1 } }, 202) : undefined),
    );
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={BOTH} />);
    const heldBlock = await screen.findByTestId('portal-directory-held-entra');
    expect(heldBlock).toHaveTextContent('1 person is waiting for your decision');
    expect(heldBlock).toHaveTextContent('first time for this directory');
    expect(screen.getByTestId('portal-directory-mode')).toHaveTextContent('On:');

    fireEvent.click(screen.getByTestId('portal-directory-apply-entra'));
    const dialog = await screen.findByTestId('portal-directory-confirm-dialog');
    expect(dialog).toHaveTextContent('1 person');
    expect(dialog).toHaveTextContent('first time for this directory');
    fireEvent.click(screen.getByTestId('portal-directory-confirm'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const [url, init] = posts()[0]!;
    expect(url).toBe(`${STATUS}/runs/run-1/apply`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ impactDigest: DIGEST });
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('dismiss posts the digest; a stale run explains itself', async () => {
    const held = run({ disposition: 'held', holdReason: 'threshold', affectedCount: 4 });
    mockStatus(
      view({ mode: 'enforce', sources: [{ source: 'entra', lastRun: held, lastEvaluatedRun: held }, { source: 'google', lastRun: null, lastEvaluatedRun: null }], openActions: [action({ status: 'held' })] }),
      (url, init) => (init?.method === 'POST' && url === `${STATUS}/runs/run-1/dismiss`
        ? json({ error: 'stale', code: 'PORTAL_DIRECTORY_RUN_STALE' }, 409) : undefined),
    );
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={BOTH} />);
    expect(await screen.findByTestId('portal-directory-held-entra')).toHaveTextContent('more people than usual');
    fireEvent.click(screen.getByTestId('portal-directory-dismiss-entra'));
    expect(await screen.findByTestId('portal-directory-confirm-dialog')).toHaveTextContent('4 people');
    fireEvent.click(screen.getByTestId('portal-directory-confirm'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({ impactDigest: DIGEST });
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: expect.stringContaining('changed since you opened it'),
    })));
  });

  it('a held run without edit rights shows no Apply or Dismiss', async () => {
    const held = run({ disposition: 'held', holdReason: 'threshold' });
    mockStatus(view({ mode: 'enforce', sources: [{ source: 'entra', lastRun: held, lastEvaluatedRun: held }, { source: 'google', lastRun: null, lastEvaluatedRun: null }] }));
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit={false} providers={BOTH} />);
    await screen.findByTestId('portal-directory-held-entra');
    expect(screen.queryByTestId('portal-directory-apply-entra')).toBeNull();
  });

  it('an incomplete run explains that nothing changed and names the reason', async () => {
    mockStatus(view({
      sources: [
        { source: 'entra', lastRun: run({ id: 'r2', outcome: 'incomplete', reason: 'sync_incomplete', disposition: 'none' }), lastEvaluatedRun: run() },
        { source: 'google', lastRun: run({ id: 'r3', outcome: 'incomplete', reason: 'scope_missing', disposition: 'none' }), lastEvaluatedRun: null },
      ],
    }));
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={BOTH} />);
    expect(await screen.findByTestId('portal-directory-source-entra')).toHaveTextContent('The last directory read was incomplete, so nothing changed.');
    expect(screen.getByTestId('portal-directory-source-google')).toHaveTextContent('admin.directory.user');
  });

  it('a tenant that is not proven links to the tenant panel; an oversized directory names the limit', async () => {
    mockStatus(view({
      sources: [
        { source: 'entra', lastRun: run({ outcome: 'skipped', reason: 'tenant_not_proven', disposition: 'none' }), lastEvaluatedRun: null },
        { source: 'google', lastRun: null, lastEvaluatedRun: null },
      ],
      openActions: [],
    }));
    // The settings page selects its tab from the hash, so this scrolls instead of re-hashing.
    const target = document.createElement('div');
    target.id = 'entra-tenant';
    const scroll = vi.fn();
    target.scrollIntoView = scroll;
    document.body.appendChild(target);
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={BOTH} />);
    fireEvent.click(await screen.findByTestId('portal-directory-tenant-link'));
    expect(scroll).toHaveBeenCalled();
    target.remove();
    expect(screen.getByTestId('portal-directory-empty')).toHaveTextContent('No one is flagged');
  });

  it('keeps-password and rearmed rows carry their tags', async () => {
    mockStatus(view({
      openActions: [
        action({ identityId: 'ident-1', keepsPassword: true, effect: 'identity' }),
        action({ id: null, runId: null, identityId: 'ident-2', portalUserId: 'pu-2', email: 'x@customer.example', name: null, provider: 'google', reason: null, effect: null, status: null, rearmed: true }),
      ],
    }));
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={BOTH} />);
    const first = await screen.findByTestId('portal-directory-action-ident-1');
    expect(within(first).getByTestId('portal-directory-tag-keeps-password-ident-1')).toHaveTextContent('Keeps password access');
    expect(first).toHaveTextContent('Turns off Microsoft sign-in only');
    const second = screen.getByTestId('portal-directory-action-ident-2');
    expect(within(second).getByTestId('portal-directory-tag-rearmed-ident-2'))
      .toHaveTextContent('Restored or dismissed by your team; the directory still reports this person disabled');
    expect(second).toHaveTextContent('x@customer.example');
  });

  it('a failed load shows a retry line, not a toast', async () => {
    fetchWithAuthMock.mockImplementation(() => json({ error: 'boom' }, 500));
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={BOTH} />);
    expect(await screen.findByTestId('portal-directory-load-error')).toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('apply and dismiss go through runAction', async () => {
    const held = run({ disposition: 'held', holdReason: 'threshold' });
    mockStatus(
      view({ mode: 'enforce', sources: [{ source: 'entra', lastRun: held, lastEvaluatedRun: held }, { source: 'google', lastRun: null, lastEvaluatedRun: null }] }),
      (_url, init) => (init?.method === 'POST' ? json(null, 204) : undefined),
    );
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={BOTH} />);
    fireEvent.click(await screen.findByTestId('portal-directory-dismiss-entra'));
    fireEvent.click(await screen.findByTestId('portal-directory-confirm'));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(runActionSpy.calls).toBe(1);
  });

  it('ships dark: without Google on this deployment, the panel never names Google', async () => {
    mockStatus(view({ openActions: [action(), action({ identityId: 'ident-g', provider: 'google' })] }));
    render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={{ microsoft: true, google: false }} />);
    const panel = await screen.findByTestId('portal-directory-panel');
    await within(panel).findByTestId('portal-directory-action-ident-1');
    expect(panel.textContent).not.toMatch(/google/i);
    expect(within(panel).queryByTestId('portal-directory-action-ident-g')).toBeNull();
  });

  it('renders nothing when the deployment runs neither directory sign-in', () => {
    mockStatus(view());
    const { container } = render(<DirectoryDeprovisioningPanel orgId={ORG} canEdit providers={{ microsoft: false, google: false }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
