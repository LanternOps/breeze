/**
 * Tool Catalog W3 (#5218) PR B — read-only flow detail.
 *
 * Pinned: steps render in document order with tier badges, validation issues
 * from the server (e.g. tool_not_found) are surfaced, the selected step lives
 * in the URL hash (`#step-<id>`). Later waves add enable / disable / run-now
 * (#5219) and, in Flows completion W01e (#12438), Edit and Delete draft.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ listFlowRuns: vi.fn().mockResolvedValue({ runs: [], total: 0 }), listFlows: vi.fn(), getFlow: vi.fn(), disableFlow: vi.fn(), enableFlow: vi.fn(), startFlowRun: vi.fn(), listWebhookDeliveries: vi.fn(), rotateWebhookSecret: vi.fn(), deleteFlowDraft: vi.fn() }));
const perms = vi.hoisted(() => ({ write: true, del: true }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: [],
    can: (r: string, a: string) => r === 'automations' && ((a === 'write' && perms.write) || (a === 'delete' && perms.del)),
  }),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: unknown) => unknown) => {
    const st = { organizations: [], currentOrgId: null };
    return sel ? sel(st) : st;
  },
}));
const navigation = vi.hoisted(() => ({ navigateTo: vi.fn() }));
vi.mock('@/lib/navigation', () => navigation);
vi.mock('./api', () => api);
const gate = vi.hoisted(() => ({ value: { enabled: true, loaded: true } }));
vi.mock('../../stores/featuresStore', () => ({ useFlowsGate: () => gate.value }));
const viewer = vi.hoisted(() => ({
  claims: { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } } as Record<string, unknown>,
  canManagePartnerWide: undefined as boolean | undefined,
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { canManagePartnerWide: viewer.canManagePartnerWide } }),
}));
vi.mock('@/lib/authScope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useJwtClaims: () => viewer.claims,
}));

import { ActionError } from '@/lib/runAction';
import FlowDetailPage from './FlowDetailPage';

const ID = '9f1c0f4e-0000-4000-8000-000000000001';

function detail() {
  return {
    flow: {
      id: ID,
      slug: 'nightly_offline',
      name: 'Nightly offline report',
      description: 'Lists offline devices',
      ownerScope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      status: 'draft',
      effectiveTier: 2,
      triggerType: 'schedule',
      definitionVersion: 3,
      updatedAt: '2026-10-20T02:00:00.000Z',
      createdAt: '2026-10-19T02:00:00.000Z',
      createdByUserId: 'u-1',
      aiSessionId: 's-1',
      enabledPublicationSeq: null as number | null,
      convertedFrom: null as Record<string, unknown> | null,
      definition: {
        version: 1,
        name: 'Nightly offline report',
        trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
        inputs: [{ name: 'days', type: 'number', required: false }],
        steps: [
          { id: 'list', tool: 'query_devices', input: { status: 'offline' }, approval: 'default', onFailure: 'stop', timeoutSec: 300 },
          { id: 'notify', tool: 'ghost_tool', input: {}, when: 'steps.list.count > 0', approval: 'pre_approved', onFailure: 'continue', timeoutSec: 60 },
        ],
      },
    },
    validation: {
      valid: false,
      effectiveTier: 2,
      steps: [
        { id: 'list', tool: 'query_devices', source: 'core', tier: 1, approval: 'default' },
        { id: 'notify', tool: 'ghost_tool', source: 'tenant', tier: 2, approval: 'pre_approved' },
      ],
      issues: [
        { code: 'tool_not_found', severity: 'error', message: 'Tool ghost_tool was not found', stepId: 'notify' },
        { code: 'input_not_supported', severity: 'warning', message: 'Input ignored', stepId: 'list' },
      ],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  gate.value = { enabled: true, loaded: true };
  perms.write = true;
  perms.del = true;
  viewer.claims = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
  viewer.canManagePartnerWide = undefined;
  api.getFlow.mockResolvedValue(detail());
});

describe('FlowDetailPage', () => {
  it('renders the steps in order with tier badges and the trigger summary', async () => {
    render(<FlowDetailPage flowId={ID} />);
    const list = await screen.findByTestId('flow-steps');
    const items = within(list).getAllByTestId(/^flow-step-(list|notify)$/);
    expect(items.map((el) => el.getAttribute('data-testid'))).toEqual(['flow-step-list', 'flow-step-notify']);
    expect(within(items[0]).getByTestId('flow-step-list-tier').textContent).toContain('1');
    expect(within(items[1]).getByTestId('flow-step-notify-tier').textContent).toContain('2');
    expect(screen.getByTestId('flow-trigger').textContent).toContain('0 2 * * *');
    expect(screen.getByTestId('flow-trigger').textContent).toContain('UTC');
  });

  it('surfaces server validation issues, errors before warnings', async () => {
    render(<FlowDetailPage flowId={ID} />);
    const panel = await screen.findByTestId('flow-issues');
    const issues = within(panel).getAllByTestId(/^flow-issue-/);
    expect(issues[0].getAttribute('data-testid')).toBe('flow-issue-tool_not_found');
    expect(issues[0].textContent).toContain('ghost_tool');
    expect(issues[1].getAttribute('data-testid')).toBe('flow-issue-input_not_supported');
  });

  it('selecting a step writes #step-<id> to the hash', async () => {
    const user = userEvent.setup();
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    await user.click(screen.getByTestId('flow-step-notify-select'));
    expect(window.location.hash).toBe('#step-notify');
    expect(screen.getByTestId('flow-step-notify').getAttribute('aria-current')).toBe('true');
  });

  it('reads the selected step from the hash on load', async () => {
    window.location.hash = '#step-list';
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    expect(screen.getByTestId('flow-step-list').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('flow-step-notify').getAttribute('aria-current')).toBeNull();
  });

  it('shows Enable for a draft flow', async () => {
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    expect(screen.getByTestId('flow-enable')).toBeTruthy();
    expect(screen.queryByTestId('flow-disable')).toBeNull();
  });

  it('hides every action without automations.write', async () => {
    perms.write = false;
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    expect(screen.queryByTestId('flow-enable')).toBeNull();
    expect(screen.queryByTestId('flow-disable')).toBeNull();
    expect(screen.queryByTestId('flow-run-now')).toBeNull();
  });

  it('tab state follows #runs', async () => {
    window.location.hash = '#runs';
    render(<FlowDetailPage flowId={ID} />);
    expect(await screen.findByTestId('flow-runs-tab')).toBeTruthy();
    expect(screen.queryByTestId('flow-steps')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('flow-tab-overview'));
    expect(window.location.hash).toBe('#overview');
    expect(await screen.findByTestId('flow-steps')).toBeTruthy();
  });

  it('enabled manual flow: Disable confirm calls disableFlow, Run now is offered, then refetches', async () => {
    const d = detail();
    Object.assign(d.flow, { status: 'enabled' });
    d.flow.definition.trigger = { type: 'manual' } as never;
    api.getFlow.mockResolvedValue(d);
    api.disableFlow.mockResolvedValue({ ok: true, cancelledRuns: 0 });
    const user = userEvent.setup();
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    expect(screen.getByTestId('flow-run-now')).toBeTruthy();
    await user.click(screen.getByTestId('flow-disable'));
    expect(api.disableFlow).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('flow-disable-confirm'));
    expect(api.disableFlow).toHaveBeenCalledWith(ID);
    await vi.waitFor(() => expect(api.getFlow).toHaveBeenCalledTimes(2));
  });

  it('shows the localized paused reason and an Enable action', async () => {
    const d = detail();
    Object.assign(d.flow, { status: 'paused', pausedReason: 'drift' });
    api.getFlow.mockResolvedValue(d);
    render(<FlowDetailPage flowId={ID} />);
    expect((await screen.findByTestId('flow-paused-reason')).textContent).toMatch(/changed after it was enabled/i);
    expect(screen.getByTestId('flow-enable')).toBeTruthy();
  });

  it('badges pre-approved steps', async () => {
    const d = detail();
    Object.assign(d.flow, { preApprovedStepIds: ['list'] });
    api.getFlow.mockResolvedValue(d);
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    expect(screen.getByTestId('flow-step-list-preapproved')).toBeTruthy();
    expect(screen.queryByTestId('flow-step-notify-preapproved')).toBeNull();
  });

  it('detail shows moved-from: the source Job links back to its conversion panel (#5221 C3)', async () => {
    const d = detail();
    Object.assign(d.flow, {
      convertedFrom: { automationId: 'a-1', name: 'Nightly cleanup', conversionId: 'c-1', state: 'switched' },
    });
    api.getFlow.mockResolvedValue(d);
    render(<FlowDetailPage flowId={ID} />);
    const moved = await screen.findByTestId('flow-moved-from');
    expect(moved.textContent).toContain('Moved from Job');
    const link = within(moved).getByRole('link', { name: 'Nightly cleanup' });
    expect(link.getAttribute('href')).toBe('/jobs#convert-a-1');
    expect(screen.queryByTestId('flow-moved-from-reverted')).toBeNull();
  });

  it('shadow: no Enable button; a notice names the job and links to its Move dialog (#12499)', async () => {
    const d = detail();
    Object.assign(d.flow, {
      status: 'draft',
      convertedFrom: { automationId: 'a-1', name: 'Nightly cleanup', conversionId: 'c-1', state: 'shadow' },
    });
    api.getFlow.mockResolvedValue(d);
    render(<FlowDetailPage flowId={ID} />);
    const notice = await screen.findByTestId('flow-shadowing-notice');
    expect(screen.queryByTestId('flow-enable')).toBeNull();
    expect(notice.textContent).toContain('Nightly cleanup');
    expect(within(notice).getByRole('link').getAttribute('href')).toBe('/jobs#convert-a-1');
  });

  it('switched: a disabled flow keeps its Enable button and shows no shadow notice (#12499)', async () => {
    const d = detail();
    Object.assign(d.flow, {
      status: 'disabled',
      convertedFrom: { automationId: 'a-1', name: 'Nightly cleanup', conversionId: 'c-1', state: 'switched' },
    });
    api.getFlow.mockResolvedValue(d);
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-moved-from');
    expect(screen.getByTestId('flow-enable')).toBeTruthy();
    expect(screen.queryByTestId('flow-shadowing-notice')).toBeNull();
  });

  it('moved-from shows once: the generated description line is not repeated beside the link (#12499)', async () => {
    const d = detail();
    Object.assign(d.flow, {
      description: 'Cleans temp files\n\nMoved from Job Nightly cleanup',
      convertedFrom: { automationId: 'a-1', name: 'Nightly cleanup', conversionId: 'c-1', state: 'switched' },
    });
    api.getFlow.mockResolvedValue(d);
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-moved-from');
    expect(screen.getAllByText(/Moved from Job/)).toHaveLength(1);
    expect(screen.getByText('Cleans temp files')).toBeTruthy();
  });

  it('a flow that was never converted shows no moved-from line', async () => {
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    expect(screen.queryByTestId('flow-moved-from')).toBeNull();
  });

  it('delete hidden for switched: a converted flow offers no Delete (#5221 C3)', async () => {
    const d = detail();
    Object.assign(d.flow, {
      status: 'enabled',
      convertedFrom: { automationId: 'a-1', name: 'Nightly cleanup', conversionId: 'c-1', state: 'switched' },
    });
    api.getFlow.mockResolvedValue(d);
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-moved-from');
    expect(screen.queryByRole('button', { name: /delete/i })).toBeNull();
  });

  it('shows the not-found state for a 404', async () => {
    api.getFlow.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    render(<FlowDetailPage flowId={ID} />);
    expect(await screen.findByTestId('flow-not-found')).toBeTruthy();
  });

  it('shows a load error (not not-found) for other failures', async () => {
    api.getFlow.mockRejectedValue(new Error('boom'));
    render(<FlowDetailPage flowId={ID} />);
    expect(await screen.findByTestId('flow-error')).toBeTruthy();
    expect(screen.queryByTestId('flow-not-found')).toBeNull();
  });

  it('renders not-found without requesting when the flag is off', () => {
    gate.value = { enabled: false, loaded: true };
    render(<FlowDetailPage flowId={ID} />);
    expect(screen.getByTestId('flow-not-found')).toBeTruthy();
    expect(api.getFlow).not.toHaveBeenCalled();
  });

  it('offers Disable (and Enable) for a paused flow', async () => {
    const d = detail();
    Object.assign(d.flow, { status: 'paused', pausedReason: 'drift' });
    api.getFlow.mockResolvedValue(d);
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    expect(screen.getByTestId('flow-disable')).toBeTruthy();
    expect(screen.getByTestId('flow-enable')).toBeTruthy();
    expect(screen.queryByTestId('flow-run-now')).toBeNull();
  });

  it('reloads the flow after a failed disable (state may have changed)', async () => {
    const d = detail();
    Object.assign(d.flow, { status: 'enabled' });
    api.getFlow.mockResolvedValue(d);
    api.disableFlow.mockRejectedValue(new ActionError('x', 409, undefined, { error: 'conflict' }));
    const user = userEvent.setup();
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    await user.click(screen.getByTestId('flow-disable'));
    await user.click(screen.getByTestId('flow-disable-confirm'));
    await vi.waitFor(() => expect(api.getFlow).toHaveBeenCalledTimes(2));
  });

  it('reloads the flow when enabling hits a version conflict', async () => {
    api.enableFlow.mockRejectedValue(new ActionError('x', 409, 'version_conflict', { error: 'version_conflict' }));
    const user = userEvent.setup();
    render(<FlowDetailPage flowId={ID} />);
    await screen.findByTestId('flow-steps');
    await user.click(screen.getByTestId('flow-enable'));
    await user.click(screen.getByTestId('flow-enable-confirm'));
    await screen.findByTestId('flow-enable-error-version_conflict');
    await vi.waitFor(() => expect(api.getFlow).toHaveBeenCalledTimes(2));
  });

  describe('Flows completion W01e (#12438): Edit and Delete draft', () => {
    function withFlow(patch: Record<string, unknown>) {
      const d = detail();
      Object.assign(d.flow, patch);
      api.getFlow.mockResolvedValue(d);
    }

    it('Edit shows for every status, an enabled flow included, and is a plain link', async () => {
      // Spec §3.1: an enabled flow's Edit opens the editor read-only, where
      // "Disable and edit" is the explicit confirmation. Edit never disables.
      for (const status of ['draft', 'disabled', 'paused', 'enabled']) {
        withFlow({ status });
        const { unmount } = render(<FlowDetailPage flowId={ID} />);
        const edit = await screen.findByTestId('flow-edit');
        expect(edit.tagName).toBe('A');
        expect(edit.getAttribute('href')).toBe(`/flows/${ID}/edit`);
        expect(within(screen.getByTestId('flow-actions')).getByTestId('flow-edit')).toBeTruthy();
        unmount();
      }
      expect(api.disableFlow).not.toHaveBeenCalled();
    });

    it('a viewer who may not change a partner-wide flow sees no Edit on it when enabled', async () => {
      viewer.claims = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
      withFlow({ status: 'enabled', ownerScope: 'partner', orgId: null, partnerId: 'p-1' });
      const first = render(<FlowDetailPage flowId={ID} />);
      await screen.findByTestId('flow-steps');
      expect(screen.queryByTestId('flow-edit')).toBeNull();
      first.unmount();

      // A partner user without partner-wide management rights.
      viewer.claims = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
      viewer.canManagePartnerWide = false;
      render(<FlowDetailPage flowId={ID} />);
      await screen.findByTestId('flow-steps');
      expect(screen.queryByTestId('flow-edit')).toBeNull();
    });

    it('Edit is hidden without automations.write, an enabled flow included', async () => {
      perms.write = false;
      for (const status of ['draft', 'enabled']) {
        withFlow({ status });
        const { unmount } = render(<FlowDetailPage flowId={ID} />);
        await screen.findByTestId('flow-steps');
        expect(screen.queryByTestId('flow-edit')).toBeNull();
        unmount();
      }
    });

    it('Delete draft shows only for a never-published, never-converted draft', async () => {
      render(<FlowDetailPage flowId={ID} />);
      expect(await screen.findByTestId('flow-delete')).toBeTruthy();
      cleanup();

      const hidden: Array<[string, Record<string, unknown>]> = [
        ['disabled', { status: 'disabled' }],
        ['once published', { enabledPublicationSeq: 2 }],
        ['converted', { convertedFrom: { automationId: 'a-1', name: 'Job', conversionId: 'c-1', state: 'reverted' } }],
      ];
      for (const [, patch] of hidden) {
        withFlow(patch);
        const { unmount } = render(<FlowDetailPage flowId={ID} />);
        await screen.findByTestId('flow-steps');
        expect(screen.queryByTestId('flow-delete')).toBeNull();
        unmount();
      }

      withFlow({});
      perms.del = false;
      render(<FlowDetailPage flowId={ID} />);
      await screen.findByTestId('flow-steps');
      expect(screen.queryByTestId('flow-delete')).toBeNull();
      // automations.delete alone governs Delete; Edit still shows with write.
      expect(screen.getByTestId('flow-edit')).toBeTruthy();
    });

    it('an org-scoped user sees no Edit or Delete on a partner-wide flow', async () => {
      viewer.claims = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
      withFlow({ ownerScope: 'partner', orgId: null, partnerId: 'p-1' });
      const first = render(<FlowDetailPage flowId={ID} />);
      await screen.findByTestId('flow-steps');
      expect(screen.queryByTestId('flow-edit')).toBeNull();
      expect(screen.queryByTestId('flow-delete')).toBeNull();
      // Enable is not governed by this rule here (the enable dialog handles it).
      expect(screen.getByTestId('flow-enable')).toBeTruthy();
      first.unmount();

      // The same org-scoped user still gets both on an org-owned flow.
      withFlow({});
      const second = render(<FlowDetailPage flowId={ID} />);
      expect(await screen.findByTestId('flow-edit')).toBeTruthy();
      expect(screen.getByTestId('flow-delete')).toBeTruthy();
      second.unmount();

      // A partner user without partner-wide management rights is hidden too.
      viewer.claims = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
      viewer.canManagePartnerWide = false;
      withFlow({ ownerScope: 'partner', orgId: null, partnerId: 'p-1' });
      const third = render(<FlowDetailPage flowId={ID} />);
      await screen.findByTestId('flow-steps');
      expect(screen.queryByTestId('flow-edit')).toBeNull();
      expect(screen.queryByTestId('flow-delete')).toBeNull();
      third.unmount();

      // A partner user with rights (or a pre-field session: undefined) sees both.
      viewer.canManagePartnerWide = undefined;
      render(<FlowDetailPage flowId={ID} />);
      expect(await screen.findByTestId('flow-edit')).toBeTruthy();
      expect(screen.getByTestId('flow-delete')).toBeTruthy();
    });

    it('confirming Delete draft deletes at the loaded version and returns to the list', async () => {
      api.deleteFlowDraft.mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<FlowDetailPage flowId={ID} />);
      await user.click(await screen.findByTestId('flow-delete'));
      expect(api.deleteFlowDraft).not.toHaveBeenCalled();
      await user.click(screen.getByTestId('flow-delete-confirm'));
      expect(api.deleteFlowDraft).toHaveBeenCalledWith(ID, 3);
      await vi.waitFor(() => expect(navigation.navigateTo).toHaveBeenCalledWith('/flows'));
    });

    it('flow_has_history renders inline with the conversion link built from the 409 body\'s automationId', async () => {
      api.deleteFlowDraft.mockRejectedValue(
        new ActionError('x', 409, 'flow_has_history', { error: 'flow_has_history', conversionId: 'c-9', automationId: 'a-9' }),
      );
      const user = userEvent.setup();
      render(<FlowDetailPage flowId={ID} />);
      await user.click(await screen.findByTestId('flow-delete'));
      await user.click(screen.getByTestId('flow-delete-confirm'));
      const alert = await screen.findByTestId('flow-delete-has-history');
      expect(alert.getAttribute('role')).toBe('alert');
      expect(within(alert).getByTestId('flow-delete-has-history-link').getAttribute('href')).toBe('/jobs#convert-a-9');
      await vi.waitFor(() => expect(screen.queryByTestId('flow-delete-confirm')).toBeNull());
      expect(navigation.navigateTo).not.toHaveBeenCalled();
    });

    it('flow_has_history without an automationId renders no conversion link', async () => {
      api.deleteFlowDraft.mockRejectedValue(new ActionError('x', 409, 'flow_has_history', { error: 'flow_has_history' }));
      const user = userEvent.setup();
      render(<FlowDetailPage flowId={ID} />);
      await user.click(await screen.findByTestId('flow-delete'));
      await user.click(screen.getByTestId('flow-delete-confirm'));
      const alert = await screen.findByTestId('flow-delete-has-history');
      expect(within(alert).queryByTestId('flow-delete-has-history-link')).toBeNull();
    });

    it('a version_conflict on delete closes the dialog and reloads the flow', async () => {
      api.deleteFlowDraft.mockRejectedValue(new ActionError('x', 409, 'version_conflict', { error: 'version_conflict' }));
      const user = userEvent.setup();
      render(<FlowDetailPage flowId={ID} />);
      await user.click(await screen.findByTestId('flow-delete'));
      await user.click(screen.getByTestId('flow-delete-confirm'));
      await vi.waitFor(() => expect(api.getFlow).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('flow-delete-has-history')).toBeNull();
      expect(navigation.navigateTo).not.toHaveBeenCalled();
    });
  });

  describe('W05 (#5220): webhook tab, secret invalidation, usage and the refusal banner', () => {
    function webhookDetail() {
      const d = detail();
      const flow = d.flow as Record<string, unknown> & { definition: Record<string, unknown> };
      flow.ownerScope = 'partner';
      flow.orgId = null;
      flow.partnerId = 'p-1';
      flow.triggerType = 'webhook';
      flow.definition.trigger = { type: 'webhook', auth: 'hmac', orgResolver: { path: 'body.customer', system: 'psa' } };
      flow.webhook = {
        url: `https://api.example.com/api/v1/webhooks/flows/${ID}`, authMode: 'hmac', secretFingerprint: 'fp',
        secretRotatedAt: '2026-10-20T02:00:00.000Z', lastAuthFailureAt: null, lastAuthFailureReason: null,
      };
      return d;
    }

    beforeEach(() => {
      api.listWebhookDeliveries.mockResolvedValue({ deliveries: [], identifiersHidden: false });
      api.rotateWebhookSecret.mockReset();
    });

    it('webhook tab follows #webhook for a webhook flow', async () => {
      api.getFlow.mockResolvedValue(webhookDetail());
      window.location.hash = '#webhook';
      render(<FlowDetailPage flowId={ID} />);
      expect(await screen.findByTestId('flow-webhook-panel')).toBeTruthy();
      expect(screen.queryByTestId('flow-steps')).toBeNull();
      const user = userEvent.setup();
      await user.click(screen.getByTestId('flow-tab-overview'));
      expect(window.location.hash).toBe('#overview');
      await user.click(screen.getByTestId('flow-tab-webhook'));
      expect(window.location.hash).toBe('#webhook');
      expect(await screen.findByTestId('flow-webhook-panel')).toBeTruthy();
    });

    it('a non-webhook flow has no webhook tab, and #webhook falls back to the overview', async () => {
      window.location.hash = '#webhook';
      render(<FlowDetailPage flowId={ID} />);
      expect(await screen.findByTestId('flow-steps')).toBeTruthy();
      expect(screen.queryByTestId('flow-tab-webhook')).toBeNull();
      expect(screen.queryByTestId('flow-webhook-panel')).toBeNull();
    });

    it('an enable that invalidated the webhook secret says so and links to the webhook tab', async () => {
      api.getFlow.mockResolvedValue(webhookDetail());
      api.enableFlow.mockResolvedValue({ ok: true, flow: {}, publication: {}, webhookSecretInvalidated: true });
      const user = userEvent.setup();
      render(<FlowDetailPage flowId={ID} />);
      await screen.findByTestId('flow-steps');
      await user.click(screen.getByTestId('flow-enable'));
      await user.click(screen.getByTestId('flow-enable-confirm'));
      const notice = await screen.findByTestId('flow-webhook-secret-invalidated');
      expect(notice.textContent).toMatch(/cleared the webhook secret/i);
      await user.click(screen.getByTestId('flow-webhook-secret-invalidated-open'));
      expect(window.location.hash).toBe('#webhook');
    });

    it('the invalidation notice clears once the operator has created a new secret', async () => {
      api.getFlow.mockResolvedValue(webhookDetail());
      api.enableFlow.mockResolvedValue({ ok: true, flow: {}, publication: {}, webhookSecretInvalidated: true });
      api.rotateWebhookSecret.mockResolvedValue({ secret: 'bwh_NEW', fingerprint: 'fp2', rotatedAt: '2026-10-26T00:00:00.000Z', warning: 'w' });
      const user = userEvent.setup();
      render(<FlowDetailPage flowId={ID} />);
      await screen.findByTestId('flow-steps');
      await user.click(screen.getByTestId('flow-enable'));
      await user.click(screen.getByTestId('flow-enable-confirm'));
      await screen.findByTestId('flow-webhook-secret-invalidated');
      await user.click(screen.getByTestId('flow-tab-webhook'));
      await user.click(await screen.findByTestId('flow-webhook-rotate'));
      await user.click(await screen.findByTestId('flow-webhook-rotate-confirm'));
      await user.click(await screen.findByTestId('flow-webhook-secret-done'));
      await vi.waitFor(() => expect(screen.queryByTestId('flow-webhook-secret-invalidated')).toBeNull());
    });

    it('an enable that kept the secret shows no invalidation notice', async () => {
      api.getFlow.mockResolvedValue(webhookDetail());
      api.enableFlow.mockResolvedValue({ ok: true, flow: {}, publication: {}, webhookSecretInvalidated: false });
      const user = userEvent.setup();
      render(<FlowDetailPage flowId={ID} />);
      await screen.findByTestId('flow-steps');
      await user.click(screen.getByTestId('flow-enable'));
      await user.click(screen.getByTestId('flow-enable-confirm'));
      await vi.waitFor(() => expect(api.getFlow).toHaveBeenCalledTimes(2));
      expect(screen.queryByTestId('flow-webhook-secret-invalidated')).toBeNull();
    });

    it('shows the refusal banner and the usage meter on the overview', async () => {
      const d = detail() as unknown as { flow: Record<string, unknown> };
      d.flow.lastAdmissionRefusal = { at: '2026-10-25T02:00:00.000Z', code: 'owner_monthly_cap_reached' };
      d.flow.usage = { periodKey: '2026-10', flowRuns: 3, flowCap: 10, ownerRuns: 100, ownerCap: 100 };
      api.getFlow.mockResolvedValue(d);
      render(<FlowDetailPage flowId={ID} />);
      expect((await screen.findByTestId('flow-refusal-banner')).textContent).toMatch(/all flows/i);
      expect(screen.getByTestId('flow-usage')).toBeTruthy();
    });
  });
});
