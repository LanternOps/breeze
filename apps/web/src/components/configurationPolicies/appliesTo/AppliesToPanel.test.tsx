import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

import AppliesToPanel from './AppliesToPanel';
import { Drawer } from '../../shared/Drawer';
import type { ConfigPolicyAppliesToSummary } from '../appliesToSummary';
import type { ConfigPolicyReach } from './appliesToApi';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const POLICY = '99999999-9999-4999-8999-999999999999';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const A1 = '11111111-1111-4111-8111-111111111111';
const PARTNER_ROW = '22222222-2222-4222-8222-222222222222';
const ORG_OWNER = { kind: 'org', orgId: ORG, orgName: 'Acme' } as const;

const ORG_ROW = { id: A1, configPolicyId: POLICY, level: 'organization', targetId: ORG, priority: 0, roleFilter: null, osFilter: null };
const ONE_ROW: ConfigPolicyAppliesToSummary = { assignmentCount: 1, allOrganizations: false, targets: [], childPolicyCount: 0 };

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;

let assignments: unknown[] = [];
let dryRun: Handler = () => jsonResponse({ dryRun: true, delta: { added: 5, removed: 0 } });
let apply: Handler = () => jsonResponse({ added: [], updated: [], removed: [] }, 201);

const applyCalls = () =>
  fetchWithAuth.mock.calls.filter((c) => String(c[0]).endsWith('/assignments/apply'));
const lastBody = (calls: unknown[][]) => JSON.parse(String((calls.at(-1)![1] as RequestInit).body));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  fetchWithAuth.mockReset();
  showToast.mockReset();
  assignments = [ORG_ROW];
  dryRun = () => jsonResponse({ dryRun: true, delta: { added: 5, removed: 0 } });
  apply = () => jsonResponse({ added: [], updated: [], removed: [] }, 201);
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === `/configuration-policies/${POLICY}/assignments`) return jsonResponse({ data: assignments });
    if (url.endsWith('/assignments/apply')) {
      const body = JSON.parse(String(init?.body));
      return (body.dryRun ? dryRun : apply)(url, init)!;
    }
    if (url.startsWith('/orgs/sites?')) return jsonResponse({ data: [{ id: SITE, name: 'HQ' }] });
    if (url.startsWith('/orgs/organizations')) return jsonResponse({ data: [] });
    return jsonResponse({ data: [] });
  });
});

type PanelProps = Partial<React.ComponentProps<typeof AppliesToPanel>>;
const renderPanel = (props: PanelProps = {}) => {
  const onApplied = vi.fn();
  const onDirtyChange = vi.fn();
  render(
    <AppliesToPanel
      policyId={POLICY}
      owner={ORG_OWNER}
      summary={null}
      reach={null}
      onApplied={onApplied}
      onDirtyChange={onDirtyChange}
      {...props}
    />,
  );
  return { onApplied, onDirtyChange };
};

async function addSite() {
  fireEvent.click(await screen.findByTestId('target-picker-level-site'));
  fireEvent.click(await screen.findByTestId(`target-picker-option-${SITE}`));
}

describe('AppliesToPanel', () => {
  it('the legend is always shown', async () => {
    renderPanel();
    expect(await screen.findByTestId('applies-to-legend')).toHaveTextContent(
      'Most specific wins, per feature: Device › Device group › Site › Organization › All organizations. A closer policy replaces the whole feature; it does not merge.',
    );
  });

  it('All organizations is not offered on an org-managed policy', async () => {
    renderPanel();
    await screen.findByTestId(`applies-to-row-${A1}`);
    expect(screen.queryByTestId('applies-to-all-orgs')).toBeNull();
    expect(screen.queryByTestId('applies-to-specific')).toBeNull();
  });

  it('an org-managed policy shows its organization locked', async () => {
    renderPanel();
    expect(await screen.findByTestId('applies-to-locked-org')).toHaveTextContent('Acme');
    // The stored organization row reads the owning org's name.
    expect(await screen.findByTestId(`applies-to-row-${A1}`)).toHaveTextContent('Acme');
  });

  it('Apply states the delta before committing', async () => {
    const { onApplied } = renderPanel();
    await screen.findByTestId(`applies-to-row-${A1}`);
    expect(screen.getByTestId('applies-to-apply')).toBeDisabled();
    await addSite();

    await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toHaveTextContent('Apply · adds 5 devices, removes 0'), { timeout: 3000 });
    const dry = lastBody(applyCalls());
    expect(dry).toEqual({ add: [{ level: 'site', targetId: SITE, priority: 0 }], update: [], remove: [], dryRun: true });

    assignments = [ORG_ROW, { ...ORG_ROW, id: '33333333-3333-4333-8333-333333333333', level: 'site', targetId: SITE }];
    fireEvent.click(screen.getByTestId('applies-to-apply'));
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(lastBody(applyCalls().filter((c) => !JSON.parse(String((c[1] as RequestInit).body)).dryRun))).toEqual({
      add: [{ level: 'site', targetId: SITE, priority: 0 }], update: [], remove: [],
    });
    // The draft reloads from the server and is clean again.
    await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toBeDisabled());
  });

  it('a partial delta is an estimate, not an exact count', async () => {
    dryRun = () => jsonResponse({ dryRun: true, delta: { added: 5, removed: 1, partial: true } });
    renderPanel();
    await screen.findByTestId(`applies-to-row-${A1}`);
    await addSite();
    await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toHaveTextContent('Apply · adds about 5 devices, removes about 1'), { timeout: 3000 });
  });

  it('never shows the delta of an earlier draft', async () => {
    let release!: () => void;
    renderPanel();
    await screen.findByTestId(`applies-to-row-${A1}`);
    await addSite();
    await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toHaveTextContent('adds 5'), { timeout: 3000 });
    dryRun = () => new Promise<Response>((resolve) => { release = () => resolve(jsonResponse({ dryRun: true, delta: { added: 7, removed: 0 } })); });
    fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
    expect(screen.getByTestId('applies-to-apply')).not.toHaveTextContent('adds 5');
    await waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 3000 });
    await act(async () => release());
    await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toHaveTextContent('adds 7'));
  });

  it('an older dry run that answers last does not overwrite the newer one', async () => {
    const pending: Array<(r: Response) => void> = [];
    dryRun = () => new Promise<Response>((resolve) => { pending.push(resolve); });
    renderPanel();
    await screen.findByTestId(`applies-to-row-${A1}`);
    await addSite();
    await waitFor(() => expect(pending).toHaveLength(1), { timeout: 3000 });
    fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
    await waitFor(() => expect(pending).toHaveLength(2), { timeout: 3000 });
    await act(async () => pending[1]!(jsonResponse({ dryRun: true, delta: { added: 7, removed: 2 } })));
    await act(async () => pending[0]!(jsonResponse({ dryRun: true, delta: { added: 5, removed: 0 } })));
    expect(screen.getByTestId('applies-to-apply')).toHaveTextContent('adds 7 devices, removes 2');
  });

  it('zero matching devices is a warning', async () => {
    dryRun = () => jsonResponse({ dryRun: true, delta: { added: 0, removed: 2 } });
    renderPanel({ reach: { direct: 2, throughChildren: 0, organizations: 1 } satisfies ConfigPolicyReach, summary: ONE_ROW });
    await screen.findByTestId(`applies-to-row-${A1}`);
    fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
    expect(await screen.findByTestId('applies-to-zero-warning', {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it('no zero warning when either count is partial', async () => {
    dryRun = () => jsonResponse({ dryRun: true, delta: { added: 0, removed: 2 } });
    renderPanel({ reach: { direct: 2, throughChildren: 0, organizations: 1, partial: true } });
    await screen.findByTestId(`applies-to-row-${A1}`);
    fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
    await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toHaveTextContent('removes 2'), { timeout: 3000 });
    expect(screen.queryByTestId('applies-to-zero-warning')).toBeNull();
  });

  it('a dry-run refusal shows at the foot and Apply waits', async () => {
    dryRun = () => jsonResponse({ error: 'Vendor updates need execute', code: 'oem_updates_execute_required' }, 403);
    renderPanel();
    await screen.findByTestId(`applies-to-row-${A1}`);
    await addSite();
    expect(await screen.findByTestId('applies-to-delta-refused', {}, { timeout: 3000 })).toHaveTextContent('Vendor updates need execute');
    expect(screen.getByTestId('applies-to-apply')).toBeDisabled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it('a 409 keeps the draft and offers reload', async () => {
    apply = () => jsonResponse({ error: 'assignment_conflict', message: 'The assignments changed since they were loaded; nothing was applied. Reload and try again.', entry: { op: 'remove', index: 0 } }, 409);
    const { onApplied } = renderPanel();
    await screen.findByTestId(`applies-to-row-${A1}`);
    fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
    await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toHaveTextContent('removes'), { timeout: 3000 });
    fireEvent.click(screen.getByTestId('applies-to-apply'));

    const conflict = await screen.findByTestId('applies-to-conflict');
    expect(conflict).toHaveTextContent('changed since they were loaded');
    expect(onApplied).not.toHaveBeenCalled();
    // The draft is kept, and the refused row says why.
    expect(screen.getByTestId(`applies-to-row-${A1}`)).toHaveAttribute('data-state', 'removed');
    expect(within(screen.getByTestId(`applies-to-row-${A1}`)).getByRole('alert')).toBeInTheDocument();

    assignments = [];
    fireEvent.click(within(conflict).getByTestId('applies-to-reload'));
    await waitFor(() => expect(screen.queryByTestId(`applies-to-row-${A1}`)).toBeNull());
    expect(screen.queryByTestId('applies-to-conflict')).toBeNull();
  });

  it('closing a dirty draft asks first', async () => {
    const onClose = vi.fn();
    function Harness() {
      const [dirty, setDirty] = useState(false);
      return (
        <Drawer open onClose={onClose} title="Applies to" closeDisabled={dirty} closeDisabledReason="Apply or discard your changes first" dataTestId="d">
          <AppliesToPanel policyId={POLICY} owner={ORG_OWNER} summary={null} reach={null} onApplied={vi.fn()} onDirtyChange={setDirty} />
        </Drawer>
      );
    }
    render(<Harness />);
    await screen.findByTestId(`applies-to-row-${A1}`);
    fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Apply or discard your changes first')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('applies-to-discard'));
    fireEvent.click(await screen.findByTestId('applies-to-discard-confirm'));
    expect(screen.getByTestId(`applies-to-row-${A1}`)).toHaveAttribute('data-state', 'unchanged');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('says when rows exist that the caller cannot see', async () => {
    const summary: ConfigPolicyAppliesToSummary = { assignmentCount: 3, allOrganizations: false, targets: [], childPolicyCount: 0 };
    renderPanel({ summary });
    expect(await screen.findByTestId('applies-to-hidden-rows')).toHaveTextContent('2');
  });

  it('All organizations replaces the organization rows on an MSP-managed policy', async () => {
    renderPanel({ owner: { kind: 'msp' } });
    await screen.findByTestId(`applies-to-row-${A1}`);
    expect(screen.getByTestId('applies-to-specific')).toBeChecked();
    fireEvent.click(screen.getByTestId('applies-to-all-orgs'));
    expect(screen.getByTestId(`applies-to-row-${A1}`)).toHaveAttribute('data-state', 'removed');
    await waitFor(() => expect(lastBody(applyCalls())).toEqual({
      add: [{ level: 'partner', priority: 0 }], update: [], remove: [A1], dryRun: true,
    }), { timeout: 3000 });
  });

  it('an MSP-managed policy with a partner row starts on All organizations', async () => {
    assignments = [{ ...ORG_ROW, id: PARTNER_ROW, level: 'partner', targetId: 'p' }];
    renderPanel({ owner: { kind: 'msp' } });
    expect(await screen.findByTestId(`applies-to-row-${PARTNER_ROW}`)).toHaveTextContent('All organizations');
    expect(screen.getByTestId('applies-to-all-orgs')).toBeChecked();
  });

  it('a failed load says so and can retry', async () => {
    fetchWithAuth.mockImplementationOnce(async () => jsonResponse({ error: 'nope' }, 500));
    renderPanel();
    expect(await screen.findByTestId('applies-to-load-error')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('applies-to-load-retry'));
    expect(await screen.findByTestId(`applies-to-row-${A1}`)).toBeInTheDocument();
  });

  describe('review round (#12544)', () => {
    it('a failed reload after Apply drops the draft so the drawer can close', async () => {
      const { onDirtyChange, onApplied } = renderPanel();
      await screen.findByTestId(`applies-to-row-${A1}`);
      fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
      await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toHaveTextContent('removes'), { timeout: 3000 });
      const base = fetchWithAuth.getMockImplementation()!;
      fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) =>
        url === `/configuration-policies/${POLICY}/assignments` ? jsonResponse({ error: 'down' }, 503) : base(url, init));
      fireEvent.click(screen.getByTestId('applies-to-apply'));
      await waitFor(() => expect(onApplied).toHaveBeenCalled());
      expect(await screen.findByTestId('applies-to-load-error')).toBeInTheDocument();
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    });

    it('Apply waits for the count before it can commit', async () => {
      let release!: () => void;
      dryRun = () => new Promise<Response>((resolve) => { release = () => resolve(jsonResponse({ dryRun: true, delta: { added: 3, removed: 0 } })); });
      renderPanel();
      await screen.findByTestId(`applies-to-row-${A1}`);
      await addSite();
      expect(screen.getByTestId('applies-to-apply')).toBeDisabled();
      await waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 3000 });
      await act(async () => release());
      await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toBeEnabled());
    });

    it('a count that could not be read still lets Apply run', async () => {
      dryRun = () => jsonResponse({ error: 'boom' }, 500);
      renderPanel();
      await screen.findByTestId(`applies-to-row-${A1}`);
      await addSite();
      await waitFor(() => expect(screen.getByTestId('applies-to-delta')).toHaveTextContent('Could not count'), { timeout: 3000 });
      expect(screen.getByTestId('applies-to-apply')).toBeEnabled();
    });

    it('a rate-limited dry run is a missing count, not a refusal', async () => {
      dryRun = () => jsonResponse({ error: 'Too many requests' }, 429);
      renderPanel();
      await screen.findByTestId(`applies-to-row-${A1}`);
      await addSite();
      await waitFor(() => expect(screen.getByTestId('applies-to-delta')).toHaveTextContent('Could not count'), { timeout: 3000 });
      expect(screen.queryByTestId('applies-to-delta-refused')).toBeNull();
      expect(screen.getByTestId('applies-to-apply')).toBeEnabled();
    });

    it('a refusal names the row it refused, and editing that row clears it', async () => {
      // One remove, one edit, two adds: the refusal names the SECOND add.
      assignments = [ORG_ROW, { ...ORG_ROW, id: PARTNER_ROW, level: 'site', targetId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }];
      dryRun = (_url, init) => {
        const body = JSON.parse(String(init!.body));
        return body.add.length === 2
          ? jsonResponse({ error: 'Target device is not in this partner', entry: { op: 'add', index: 1 } }, 403)
          : jsonResponse({ dryRun: true, delta: { added: 1, removed: 0 } });
      };
      fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === `/configuration-policies/${POLICY}/assignments`) return jsonResponse({ data: assignments });
        if (url.endsWith('/assignments/apply')) return dryRun(url, init)!;
        if (url.startsWith('/orgs/sites?')) return jsonResponse({ data: [{ id: SITE, name: 'HQ' }] });
        if (url.startsWith('/devices?')) return jsonResponse({ data: [{ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', hostname: 'PC-9' }] });
        return jsonResponse({ data: [] });
      });
      renderPanel();
      await screen.findByTestId(`applies-to-row-${A1}`);
      fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
      fireEvent.change(screen.getByTestId(`applies-to-row-priority-${PARTNER_ROW}`), { target: { value: '7' } });
      await addSite();
      fireEvent.click(screen.getByTestId('target-picker-level-device'));
      fireEvent.click(await screen.findByTestId('target-picker-option-ffffffff-ffff-4fff-8fff-ffffffffffff'));

      await screen.findByTestId('applies-to-delta-refused', {}, { timeout: 3000 });
      const added = screen.getAllByTestId(/^applies-to-row-added-/).filter((el) => el.hasAttribute('data-state'));
      expect(added).toHaveLength(2);
      expect(within(added[1]!).getByRole('alert')).toHaveTextContent('Target device is not in this partner');
      expect(within(added[0]!).queryByRole('alert')).toBeNull();
      expect(within(screen.getByTestId(`applies-to-row-${A1}`)).queryByRole('alert')).toBeNull();

      // Removing the refused row changes the draft: the old message goes.
      fireEvent.click(within(added[1]!).getByTestId(/^applies-to-row-remove-/));
      await waitFor(() => expect(screen.queryAllByRole('alert')).toHaveLength(0));
    });

    it('no zero warning while the summary is unknown (hidden rows may exist)', async () => {
      dryRun = () => jsonResponse({ dryRun: true, delta: { added: 0, removed: 2 } });
      renderPanel({ reach: { direct: 2, throughChildren: 0, organizations: 1 }, summary: null });
      await screen.findByTestId(`applies-to-row-${A1}`);
      fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
      await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toHaveTextContent('removes 2'), { timeout: 3000 });
      expect(screen.queryByTestId('applies-to-zero-warning')).toBeNull();
    });

    it('the picker is inert while an Apply runs', async () => {
      let release!: () => void;
      apply = () => new Promise<Response>((resolve) => { release = () => resolve(jsonResponse({ added: [], updated: [], removed: [] }, 201)); });
      renderPanel();
      await screen.findByTestId(`applies-to-row-${A1}`);
      fireEvent.click(screen.getByTestId(`applies-to-row-remove-${A1}`));
      await waitFor(() => expect(screen.getByTestId('applies-to-apply')).toBeEnabled(), { timeout: 3000 });
      fireEvent.click(screen.getByTestId('applies-to-apply'));
      await waitFor(() => expect(release).toBeTypeOf('function'));
      fireEvent.click(screen.getByTestId('target-picker-level-site'));
      expect(await screen.findByTestId(`target-picker-option-${SITE}`)).toBeDisabled();
      await act(async () => release());
    });
  });
});

describe('activation mode (W03d C3)', () => {
  const activationProps = () => ({
    onActivate: vi.fn(async (_payload: unknown) => null as string | null),
    onDontApply: vi.fn(async () => null as string | null),
  });

  it("Activate needs a target or Don't apply yet", async () => {
    assignments = [];
    const activation = activationProps();
    renderPanel({ activation, reach: { direct: 0, throughChildren: 0, organizations: 0 } });
    const activate = await screen.findByTestId('config-policy-activation-activate');
    expect(activate).toBeDisabled();
    expect(screen.getByTestId('config-policy-activation-needs-decision')).toHaveTextContent(/at least one target/);
    // The ordinary Apply is not offered in this mode.
    expect(screen.queryByTestId('applies-to-apply')).toBeNull();
    expect(screen.getByTestId('config-policy-activation-dont-apply')).toBeEnabled();
    fireEvent.click(screen.getByTestId('config-policy-activation-dont-apply'));
    await waitFor(() => expect(activation.onDontApply).toHaveBeenCalledTimes(1));
    expect(activation.onActivate).not.toHaveBeenCalled();
  });

  it('a staged target enables Activate, which states its reach and hands over the staged change', async () => {
    assignments = [];
    const activation = activationProps();
    renderPanel({ activation, reach: { direct: 0, throughChildren: 0, organizations: 0 } });
    await addSite();
    const activate = screen.getByTestId('config-policy-activation-activate');
    await waitFor(() => expect(activate).toHaveTextContent('Activate · reaches 5 devices'));
    fireEvent.click(activate);
    await waitFor(() => expect(activation.onActivate).toHaveBeenCalledTimes(1));
    expect(activation.onActivate).toHaveBeenCalledWith(
      expect.objectContaining({ add: [expect.objectContaining({ level: 'site', targetId: SITE })] }),
    );
    // The panel itself never applies in this mode: the page sequences it.
    expect(applyCalls().filter((c) => !JSON.parse(String((c[1] as RequestInit).body)).dryRun)).toHaveLength(0);
  });

  it('with no policy yet nothing is read or counted, and Activate claims no number', async () => {
    const activation = activationProps();
    renderPanel({ policyId: null, activation });
    expect(await screen.findByTestId('applies-to-empty')).toBeInTheDocument();
    await addSite();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });
    expect(fetchWithAuth.mock.calls.filter((c) => String(c[0]).startsWith('/configuration-policies'))).toEqual([]);
    expect(screen.getByTestId('config-policy-activation-activate')).toHaveTextContent(/^Activate$/);
    expect(screen.getByTestId('config-policy-activation-activate')).toBeEnabled();
  });

  it('shows the reason Activate failed and stays open', async () => {
    assignments = [];
    const activation = activationProps();
    activation.onActivate.mockResolvedValueOnce('The targets were not applied, so nothing was activated. The policy stays inactive.');
    renderPanel({ activation, reach: { direct: 0, throughChildren: 0, organizations: 0 } });
    await addSite();
    await waitFor(() => expect(screen.getByTestId('config-policy-activation-activate')).toBeEnabled());
    fireEvent.click(screen.getByTestId('config-policy-activation-activate'));
    expect(await screen.findByTestId('config-policy-activation-error')).toHaveTextContent(/stays inactive/);
  });

  it('no target is pre-selected; the switcher org is first', async () => {
    const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return jsonResponse({ data: [{ id: OTHER, name: 'Birch' }, { id: ORG, name: 'Acme' }] });
      return jsonResponse({ data: [] });
    });
    renderPanel({ policyId: null, owner: { kind: 'msp' }, activation: activationProps(), suggestedOrg: { id: ORG, name: 'Acme' } });
    expect(await screen.findByTestId('applies-to-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('applies-to-specific'));
    fireEvent.click(await screen.findByTestId('target-picker-level-organization'));
    await screen.findByTestId(`target-picker-option-${ORG}`);
    const options = screen.getAllByTestId(/^target-picker-option-/);
    expect(options[0]).toHaveAttribute('data-testid', `target-picker-option-${ORG}`);
    expect(options[1]).toHaveAttribute('data-testid', `target-picker-option-${OTHER}`);
    // Still nothing staged until the user picks.
    expect(screen.getByTestId('applies-to-empty')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-activation-activate')).toBeDisabled();
  });
});
