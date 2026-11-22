/**
 * Flows completion W01e (#12438) Task E2: the manual flow editor shell.
 *
 * Pinned: a form-shaped document opens in the form and a non-form one opens
 * read-only on the Document tab; saves send expectedVersion and never a PUT
 * for an unchanged document (a PUT bumps the draft and invalidates a minted
 * webhook secret, Decision P17); a 409 keeps the unsaved document; Save and
 * enable re-fetches the flow so the dialog gets real pre-approval
 * eligibility; webhook flows are saved here and enabled on the flow page
 * (Decision P21).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileFlowForm, type FlowFormValues } from '@breeze/shared';

const api = vi.hoisted(() => ({
  getFlow: vi.fn(),
  createFlowDraft: vi.fn(),
  updateFlowDraft: vi.fn(),
  disableFlow: vi.fn(),
  validateFlowDraftDocument: vi.fn(),
}));
vi.mock('../api', () => api);
const nav = vi.hoisted(() => ({ navigateTo: vi.fn().mockResolvedValue('soft') }));
vi.mock('@/lib/navigation', () => nav);
const gate = vi.hoisted(() => ({ value: { enabled: true, loaded: true } }));
vi.mock('../../../stores/featuresStore', () => ({ useFlowsGate: () => gate.value }));
const perms = vi.hoisted(() => ({ write: true }));
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => r === 'automations' && (a === 'read' || (a === 'write' && perms.write)) }),
}));
const authState = vi.hoisted(() => ({ user: { canManagePartnerWide: false } as { canManagePartnerWide?: boolean } }));
vi.mock('../../../stores/auth', () => ({
  useAuthStore: (sel?: (s: unknown) => unknown) => (sel ? sel(authState) : authState),
  getJwtClaims: () => ({ scope: authState.user.canManagePartnerWide ? 'partner' : 'organization', partnerId: 'p1', orgId: null }),
  fetchWithAuth: vi.fn(),
}));
const jwt = vi.hoisted(() => ({ value: { status: 'unresolved' } as unknown }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => jwt.value }));
vi.mock('../../../stores/orgStore', () => ({
  useOrgStore: (sel?: (s: unknown) => unknown) => {
    const st = { organizations: [], currentOrgId: 'org-1' };
    return sel ? sel(st) : st;
  },
}));
vi.mock('./FlowFormView', () => ({
  FlowFormView: ({ values, onChange, readOnly }: { values: FlowFormValues; onChange: (v: FlowFormValues) => void; readOnly?: boolean }) => (
    <div data-testid="mock-form" data-readonly={String(!!readOnly)}>
      <span data-testid="mock-form-name">{values.name}</span>
      <button type="button" data-testid="mock-form-rename" onClick={() => onChange({ ...values, name: `${values.name}!` })}>rename</button>
    </div>
  ),
}));
vi.mock('./FlowDocumentTab', () => ({
  FlowDocumentTab: ({ text, onChange, parseError }: { text: string; onChange: (t: string) => void; parseError: string | null }) => (
    <div>
      <textarea data-testid="mock-doc" value={text} onChange={(e) => onChange(e.target.value)} />
      {parseError && <p data-testid="flow-editor-parse-error">{parseError}</p>}
    </div>
  ),
}));
vi.mock('../FlowEnableDialog', () => ({
  FlowEnableDialog: ({ flow, onEnabled, onClose }: { flow: { preApprovalEligibility: unknown }; onEnabled: (r: unknown) => void; onClose: () => void }) => (
    <div data-testid="mock-enable" data-eligibility={JSON.stringify(flow.preApprovalEligibility)}>
      <button type="button" data-testid="mock-enable-close" onClick={onClose}>close</button>
      <button type="button" data-testid="mock-enable-ok" onClick={() => onEnabled({ ok: true, webhookSecretInvalidated: false })}>ok</button>
      <button type="button" data-testid="mock-enable-cleared" onClick={() => onEnabled({ ok: true, webhookSecretInvalidated: true })}>cleared</button>
    </div>
  ),
}));

import { ActionError } from '@/lib/runAction';
import FlowEditorPage from './FlowEditorPage';

const ID = '9f1c0f4e-0000-4000-8000-000000000001';
const SCRIPT = '33333333-3333-4333-8333-333333333333';
const values: FlowFormValues = {
  name: 'Nightly cleanup',
  trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' },
  target: { kind: 'target', target: { type: 'all' } },
  actions: [{ type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue' }],
  onFailure: { mode: 'stop' },
};
const validation = { valid: true, effectiveTier: 3, steps: [{ id: 'a0_run_script', tool: 'run_script_on_targets', source: 'builtin', tier: 3, approval: 'default' }], issues: [] };

function flow(overrides: Record<string, unknown> = {}, definition: unknown = compileFlowForm(values)) {
  return {
    id: ID, slug: 'nightly_cleanup', name: 'Nightly cleanup', description: null, ownerScope: 'organization',
    orgId: 'org-1', partnerId: null, status: 'draft', effectiveTier: 3, triggerType: 'schedule',
    definitionVersion: 3, updatedAt: '2026-11-21T00:00:00.000Z', createdAt: '2026-11-21T00:00:00.000Z',
    createdByUserId: 'u1', aiSessionId: null, enabledPublicationSeq: null, enabledAt: null, enabledByUserId: null,
    pausedReason: null, preApprovalEligibility: {}, preApprovedStepIds: [], webhook: null, usage: null,
    convertedFrom: null, lastAdmissionRefusal: null, definition, ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '';
  gate.value = { enabled: true, loaded: true };
  perms.write = true;
  authState.user = { canManagePartnerWide: false };
  jwt.value = { status: 'unresolved' };
  api.validateFlowDraftDocument.mockResolvedValue(validation);
  api.getFlow.mockResolvedValue({ flow: flow(), validation });
});

describe('FlowEditorPage', () => {
  it('a form-shaped draft opens in the form', async () => {
    render(<FlowEditorPage flowId={ID} />);
    expect(await screen.findByTestId('mock-form-name')).toHaveTextContent('Nightly cleanup');
    expect(screen.getByTestId('mock-form')).toHaveAttribute('data-readonly', 'false');
    expect(screen.queryByTestId('flow-editor-not-form-shaped')).toBeNull();
    expect(screen.getByTestId('flow-editor-tab-form')).toHaveAttribute('aria-selected', 'true');
  });

  it('a non-form document opens read-only with the Document tab active', async () => {
    const doc = { ...compileFlowForm(values), limits: { monthlyRuns: 5 } };
    api.getFlow.mockResolvedValue({ flow: flow({}, doc), validation });
    render(<FlowEditorPage flowId={ID} />);
    expect(await screen.findByTestId('mock-doc')).toBeInTheDocument();
    expect(screen.getByTestId('flow-editor-tab-document')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByTestId('flow-editor-tab-form'));
    expect(await screen.findByTestId('flow-editor-not-form-shaped')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-form')).toBeNull();
    expect(screen.getByTestId('flow-steps')).toBeInTheDocument();
  });

  it('Save on a new flow creates and navigates to edit', async () => {
    api.createFlowDraft.mockResolvedValue({ flow: flow(), validation });
    render(<FlowEditorPage />);
    fireEvent.click(await screen.findByTestId('mock-form-rename'));
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    await waitFor(() => expect(api.createFlowDraft).toHaveBeenCalledTimes(1));
    const body = api.createFlowDraft.mock.calls[0][0];
    expect(body.document.name).toBe('!');
    expect(body.orgId).toBe('org-1');
    expect(body.ownerScope).toBeUndefined();
    await waitFor(() => expect(nav.navigateTo).toHaveBeenCalledWith(`/flows/${ID}/edit`));
  });

  it('Save on an existing flow sends expectedVersion and holds the returned version and document', async () => {
    const renamed = compileFlowForm({ ...values, name: 'Nightly cleanup!' });
    api.updateFlowDraft.mockResolvedValue({ flow: flow({ definitionVersion: 4 }, renamed), validation });
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('mock-form-rename'));
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    await waitFor(() => expect(api.updateFlowDraft).toHaveBeenCalledTimes(1));
    expect(api.updateFlowDraft.mock.calls[0][1].expectedVersion).toBe(3);
    // A second Save with nothing changed since sends no PUT (the baseline moved to the saved document).
    fireEvent.click(await screen.findByTestId('flow-editor-save'));
    await screen.findByTestId('flow-editor-saved');
    expect(api.updateFlowDraft).toHaveBeenCalledTimes(1);
    // And the next change saves against version 4.
    fireEvent.click(screen.getByTestId('mock-form-rename'));
    api.updateFlowDraft.mockResolvedValue({ flow: flow({ definitionVersion: 5 }, compileFlowForm({ ...values, name: 'Nightly cleanup!!' })), validation });
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    await waitFor(() => expect(api.updateFlowDraft).toHaveBeenCalledTimes(2));
    expect(api.updateFlowDraft.mock.calls[1][1].expectedVersion).toBe(4);
  });

  it('an enabled flow is read-only and Disable and edit confirms what is cancelled', async () => {
    api.getFlow.mockResolvedValueOnce({ flow: flow({ status: 'enabled' }), validation });
    api.getFlow.mockResolvedValueOnce({ flow: flow({ status: 'disabled' }), validation });
    api.disableFlow.mockResolvedValue({ ok: true, cancelledRuns: 0 });
    render(<FlowEditorPage flowId={ID} />);
    expect(await screen.findByTestId('flow-editor-enabled-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('mock-form')).toHaveAttribute('data-readonly', 'true');
    expect(screen.queryByTestId('flow-editor-save')).toBeNull();
    fireEvent.click(screen.getByTestId('flow-editor-disable-and-edit'));
    expect(await screen.findByText(/cancels queued and waiting runs/i)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flow-editor-disable-confirm'));
    await waitFor(() => expect(api.disableFlow).toHaveBeenCalledWith(ID));
    await waitFor(() => expect(screen.getByTestId('mock-form')).toHaveAttribute('data-readonly', 'false'));
    expect(screen.getByTestId('flow-editor-save')).toBeInTheDocument();
  });

  it('saving a shadow draft warns that evidence resets', async () => {
    api.getFlow.mockResolvedValue({ flow: flow({ convertedFrom: { automationId: 'a1', name: 'Job', conversionId: 'c1', state: 'shadow' } }), validation });
    api.updateFlowDraft.mockResolvedValue({ flow: flow({ definitionVersion: 4 }, compileFlowForm({ ...values, name: 'Nightly cleanup!' })), validation });
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('mock-form-rename'));
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    expect(await screen.findByTestId('flow-editor-shadow-confirm')).toBeInTheDocument();
    expect(api.updateFlowDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('flow-editor-shadow-confirm'));
    await waitFor(() => expect(api.updateFlowDraft).toHaveBeenCalledTimes(1));
  });

  it('a 409 keeps the unsaved document and offers reload', async () => {
    api.updateFlowDraft.mockRejectedValue(new ActionError('conflict', 409, undefined, { error: 'version_conflict' }));
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('mock-form-rename'));
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    expect(await screen.findByTestId('flow-editor-conflict')).toBeInTheDocument();
    expect(screen.getByTestId('mock-form-name')).toHaveTextContent('Nightly cleanup!');
    expect(api.getFlow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('flow-editor-reload'));
    await waitFor(() => expect(api.getFlow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('mock-form-name')).toHaveTextContent(/^Nightly cleanup$/));
  });

  it('a 422 shows the returned validation inline', async () => {
    const bad = { valid: false, effectiveTier: null, steps: [], issues: [{ code: 'tool_not_found', severity: 'error', message: 'Script not found' }] };
    api.updateFlowDraft.mockRejectedValue(new ActionError('invalid', 422, undefined, { error: 'invalid', validation: bad }));
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('mock-form-rename'));
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    expect(await screen.findByTestId('flow-editor-save-invalid')).toBeInTheDocument();
    expect(screen.getByTestId('flow-issue-tool_not_found')).toBeInTheDocument();
  });

  it('the owner selector shows only for partner-wide-capable users and only on create', async () => {
    const { unmount } = render(<FlowEditorPage />);
    await screen.findByTestId('mock-form');
    expect(screen.queryByTestId('flow-editor-owner')).toBeNull();
    unmount();

    authState.user = { canManagePartnerWide: true };
    api.createFlowDraft.mockResolvedValue({ flow: flow({ ownerScope: 'partner' }), validation });
    const second = render(<FlowEditorPage />);
    expect(await screen.findByTestId('flow-editor-owner')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flow-editor-owner-partner'));
    fireEvent.click(screen.getByTestId('mock-form-rename'));
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    await waitFor(() => expect(api.createFlowDraft).toHaveBeenCalledTimes(1));
    expect(api.createFlowDraft.mock.calls[0][0].ownerScope).toBe('partner');
    expect(api.createFlowDraft.mock.calls[0][0].orgId).toBeUndefined();
    second.unmount();

    render(<FlowEditorPage flowId={ID} />);
    await screen.findByTestId('mock-form');
    expect(screen.queryByTestId('flow-editor-owner')).toBeNull();
  });

  it('the tab follows the hash', async () => {
    window.location.hash = 'document';
    render(<FlowEditorPage flowId={ID} />);
    expect(await screen.findByTestId('mock-doc')).toBeInTheDocument();
    act(() => {
      window.location.hash = 'form';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByTestId('mock-form')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flow-editor-tab-document'));
    expect(window.location.hash).toBe('#document');
  });

  it('a Document-tab edit that the form cannot express locks the form instead of dropping it', async () => {
    api.updateFlowDraft.mockImplementation(async (_id: string, body: { document: unknown }) => ({ flow: flow({ definitionVersion: 4 }, body.document), validation }));
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('flow-editor-tab-document'));
    const doc = JSON.parse((screen.getByTestId('mock-doc') as HTMLTextAreaElement).value);
    doc.steps[0].timeoutSec = 600;
    const typed = JSON.stringify(doc, null, 4);
    fireEvent.change(screen.getByTestId('mock-doc'), { target: { value: typed } });
    fireEvent.click(screen.getByTestId('flow-editor-tab-form'));
    expect(await screen.findByTestId('flow-editor-not-form-shaped')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    await waitFor(() => expect(api.updateFlowDraft).toHaveBeenCalledTimes(1));
    expect(api.updateFlowDraft.mock.calls[0][1].document.steps[0].timeoutSec).toBe(600);
  });

  it('a JSON parse error blocks save', async () => {
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('flow-editor-tab-document'));
    fireEvent.change(screen.getByTestId('mock-doc'), { target: { value: '{ nope' } });
    expect(screen.getByTestId('flow-editor-parse-error')).toBeInTheDocument();
    expect(screen.getByTestId('flow-editor-save')).toBeDisabled();
  });

  it('Save and enable with no change sends no PUT', async () => {
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('flow-editor-save-enable'));
    expect(await screen.findByTestId('mock-enable')).toBeInTheDocument();
    expect(api.updateFlowDraft).not.toHaveBeenCalled();
  });

  it('Save and enable re-fetches the flow before opening the enable dialog', async () => {
    const eligibility = { a0_run_script: { eligible: true } };
    api.updateFlowDraft.mockResolvedValue({ flow: flow({ definitionVersion: 4 }, compileFlowForm({ ...values, name: 'Nightly cleanup!' })), validation });
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('mock-form-rename'));
    api.getFlow.mockResolvedValue({ flow: flow({ definitionVersion: 4, preApprovalEligibility: eligibility }, compileFlowForm({ ...values, name: 'Nightly cleanup!' })), validation });
    fireEvent.click(screen.getByTestId('flow-editor-save-enable'));
    const dialog = await screen.findByTestId('mock-enable');
    expect(api.updateFlowDraft).toHaveBeenCalledTimes(1);
    expect(api.getFlow).toHaveBeenCalledTimes(2);
    expect(JSON.parse(dialog.getAttribute('data-eligibility') ?? 'null')).toEqual(eligibility);
  });

  it('Save and enable on a new flow creates it once; closing the dialog and saving again updates it', async () => {
    api.createFlowDraft.mockResolvedValue({ flow: flow(), validation });
    api.updateFlowDraft.mockImplementation(async (_id: string, body: { document: unknown }) => ({ flow: flow({ definitionVersion: 4 }, body.document), validation }));
    render(<FlowEditorPage />);
    fireEvent.click(await screen.findByTestId('flow-editor-save-enable'));
    fireEvent.click(await screen.findByTestId('mock-enable-close'));
    await waitFor(() => expect(screen.getByTestId('mock-form-name')).toHaveTextContent(/^Nightly cleanup$/));
    fireEvent.click(screen.getByTestId('mock-form-rename'));
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    await waitFor(() => expect(api.updateFlowDraft).toHaveBeenCalledTimes(1));
    expect(api.createFlowDraft).toHaveBeenCalledTimes(1);
    expect(api.updateFlowDraft.mock.calls[0][0]).toBe(ID);
  });

  it('a successful enable navigates to the flow', async () => {
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('flow-editor-save-enable'));
    fireEvent.click(await screen.findByTestId('mock-enable-ok'));
    await waitFor(() => expect(nav.navigateTo).toHaveBeenCalledWith(`/flows/${ID}`));
  });

  it('an enable result that reports a cleared webhook secret stays on the editor with the notice and a link to the webhook tab', async () => {
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('flow-editor-save-enable'));
    fireEvent.click(await screen.findByTestId('mock-enable-cleared'));
    const notice = await screen.findByTestId('flow-editor-webhook-secret-invalidated');
    expect(notice.querySelector('a')).toHaveAttribute('href', `/flows/${ID}#webhook`);
    expect(nav.navigateTo).not.toHaveBeenCalled();
  });

  it('a webhook flow offers Save only and links to the webhook tab after saving', async () => {
    const hook = compileFlowForm({ ...values, trigger: { type: 'webhook', auth: 'hmac' } });
    api.getFlow.mockResolvedValue({ flow: flow({ triggerType: 'webhook' }, hook), validation });
    api.updateFlowDraft.mockImplementation(async (_id: string, body: { document: unknown }) => ({ flow: flow({ definitionVersion: 4, triggerType: 'webhook' }, body.document), validation }));
    render(<FlowEditorPage flowId={ID} />);
    fireEvent.click(await screen.findByTestId('mock-form-rename'));
    expect(screen.queryByTestId('flow-editor-save-enable')).toBeNull();
    fireEvent.click(screen.getByTestId('flow-editor-save'));
    const next = await screen.findByTestId('flow-editor-webhook-next');
    expect(next.querySelector('a')).toHaveAttribute('href', `/flows/${ID}#webhook`);
  });

  it('an org-scoped viewer gets a read-only editor for a partner-wide flow', async () => {
    jwt.value = { status: 'resolved', claims: { scope: 'organization', partnerId: null, orgId: 'org-1' } };
    api.getFlow.mockResolvedValue({ flow: flow({ ownerScope: 'partner', orgId: null, partnerId: 'p1' }), validation });
    render(<FlowEditorPage flowId={ID} />);
    expect(await screen.findByTestId('mock-form')).toHaveAttribute('data-readonly', 'true');
    expect(screen.queryByTestId('flow-editor-save')).toBeNull();
  });

  it('a partner viewer who may manage partner-wide state can edit a partner-wide flow', async () => {
    jwt.value = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p1', orgId: null } };
    authState.user = { canManagePartnerWide: true };
    api.getFlow.mockResolvedValue({ flow: flow({ ownerScope: 'partner', orgId: null, partnerId: 'p1' }), validation });
    render(<FlowEditorPage flowId={ID} />);
    expect(await screen.findByTestId('mock-form')).toHaveAttribute('data-readonly', 'false');
  });

  it('states the run limits next to Save', async () => {
    render(<FlowEditorPage flowId={ID} />);
    expect(await screen.findByTestId('flow-editor-limits')).toHaveTextContent(/500/);
  });
});
