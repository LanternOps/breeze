/**
 * `identity_onboarding` start form (Operator Recipe Library W07 R2b, Task 17).
 *
 * Every case renders the REAL entry point, `StartRecipeForm`, with an
 * onboarding workflow: the field group is selected by `recipeKey`, so a test
 * that rendered `StartRecipeOnboardingFields` alone could not catch the form
 * picking the wrong one.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiOperatorIdentityOnboardingTaskDraftDto, AiOperatorWorkflowDto } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/Toast')>();
  return { ...actual, showToast: (...args: unknown[]) => showToast(...args) };
});

import { fetchWithAuth } from '../../stores/auth';
import StartRecipeForm from './StartRecipeForm';

const fetchMock = vi.mocked(fetchWithAuth);
const ORG = '11111111-1111-4111-8111-111111111111';
const MANAGER = '33333333-3333-4333-8333-333333333333';
const MODEL = '44444444-4444-4444-8444-444444444444';
const EXISTING = '55555555-5555-4555-8555-555555555555';
const SKU_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SKU_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const GROUP_A = 'bbbbbbbb-0000-4000-8000-000000000001';
const GROUP_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const UPN = 'priya@customer.example';

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const WORKFLOW: AiOperatorWorkflowDto = {
  recipeKey: 'identity_onboarding', recipeVersion: 3, name: 'Onboard a person', summary: 's',
  gateClass: 'deterministic', targetKinds: ['contact'], readiness: 'ready', missingCapabilities: [],
  alwaysManualCapabilities: [], manualStepCount: 0, degradedEffects: [], agentId: null, agentKind: 'helpdesk',
};

type Draft = AiOperatorIdentityOnboardingTaskDraftDto;
function draft(overrides: Partial<Draft> = {}): Draft {
  return {
    recipeKey: 'identity_onboarding', recipeVersion: 3, input: {} as Draft['input'], workflow: WORKFLOW,
    createPlanPreview: [
      { ordinal: 0, toolName: 'm365_create_user', provider: 'm365', principalLabel: UPN, arguments: { userPrincipalName: UPN } },
    ],
    provisionPlanPreview: [
      { ordinal: 0, toolName: 'm365_assign_license', provider: 'm365', principalLabel: UPN, arguments: { skuIds: [SKU_A] } },
      { ordinal: 1, toolName: 'm365_add_to_group', provider: 'm365', principalLabel: UPN, arguments: { groupId: GROUP_A } },
    ],
    flags: [],
    manualWork: [{ key: 'credential_handover', label: 'Hand Priya their sign-in details', detail: 'd', origin: 'always' }],
    ...overrides,
  };
}

let draftResponse: () => Response = () => json({ data: draft() });
let startResponse: () => Response = () => json({ taskId: 'task-new', replayed: false }, 202);

beforeEach(() => {
  fetchMock.mockReset();
  navigateTo.mockReset();
  showToast.mockReset();
  draftResponse = () => json({ data: draft() });
  startResponse = () => json({ taskId: 'task-new', replayed: false }, 202);
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/ai/operator/task-drafts') return draftResponse();
    if (url === '/ai/operator/tasks') return startResponse();
    if (url.startsWith(`/orgs/organizations/${ORG}/contacts`)) {
      return json({ data: [
        { id: MANAGER, name: 'Morgan Manager', email: 'morgan@customer.example', phone: null, siteId: null },
        { id: MODEL, name: 'Mo Model', email: 'mo@customer.example', phone: null, siteId: null },
      ], pagination: { total: 2 } });
    }
    if (url.startsWith('/orgs/sites')) return json({ data: [], pagination: { total: 0 } });
    if (url.startsWith('/devices')) return json({ data: [] });
    return json({ error: `unexpected ${url}` }, 404);
  });
});
afterEach(() => vi.clearAllMocks());

const posts = (url: string) => fetchMock.mock.calls
  .filter(([u, i]) => String(u) === url && (i as RequestInit | undefined)?.method === 'POST')
  .map(([, i]) => JSON.parse(String((i as RequestInit).body)) as Record<string, any>);

function renderForm(launch: Parameters<typeof StartRecipeForm>[0]['launch'] = { kind: 'library' }) {
  return render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={launch} />);
}

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });

/** The minimum a valid M365-only onboarding needs. */
function fillM365() {
  type('start-recipe-display-name', 'Priya Patel');
  fireEvent.click(screen.getByTestId('start-recipe-provider-m365'));
  type('start-recipe-upn', UPN);
  type('start-recipe-usage-location', 'GB');
}

function addSku(id: string) {
  type('start-recipe-sku-input', id);
  fireEvent.click(screen.getByTestId('start-recipe-sku-add'));
}
function addGroup(id: string) {
  type('start-recipe-group-input', id);
  fireEvent.click(screen.getByTestId('start-recipe-group-add'));
}

async function preview() {
  fireEvent.click(screen.getByTestId('start-recipe-preview-button'));
  return screen.findByTestId('start-recipe-preview');
}

async function previewAndSubmit() {
  await preview();
  await waitFor(() => expect(screen.getByTestId('start-recipe-submit')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('start-recipe-submit'));
}

describe('StartRecipeForm — identity_onboarding variant', () => {
  it('1. the onboarding recipeKey renders the onboarding fields and none of offboarding\'s', () => {
    renderForm();
    expect(screen.getByTestId('start-recipe-display-name')).toBeInTheDocument();
    expect(screen.getByTestId('start-recipe-person-will-be-created')).toHaveTextContent('This person will be created as a contact when the task starts.');
    expect(screen.queryByTestId('start-recipe-inheritor')).toBeNull();
    expect(screen.queryByTestId('start-recipe-effect-disableAccount')).toBeNull();
    expect(screen.queryByTestId('start-recipe-devices')).toBeNull();
    expect(screen.queryByTestId('start-recipe-person-hint')).toBeNull();
    // And no device list is even read.
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith('/devices'))).toBe(false);
  });

  it('2. both provider switches are off by default and no block is rendered', () => {
    renderForm();
    expect(screen.getByTestId('start-recipe-provider-m365')).not.toBeChecked();
    expect(screen.getByTestId('start-recipe-provider-google')).not.toBeChecked();
    expect(screen.queryByTestId('start-recipe-m365-block')).toBeNull();
    expect(screen.queryByTestId('start-recipe-google-block')).toBeNull();
  });

  it('3. turning a provider off clears its block: the submitted block is null, and turning it back on starts empty', async () => {
    renderForm();
    fillM365();
    fireEvent.click(screen.getByTestId('start-recipe-provider-google'));
    type('start-recipe-google-primary-email', 'priya@customer-mail.example');
    type('start-recipe-google-given-name', 'Priya');
    type('start-recipe-google-family-name', 'Patel');
    // Cancel Google after filling it.
    fireEvent.click(screen.getByTestId('start-recipe-provider-google'));
    expect(screen.queryByTestId('start-recipe-google-block')).toBeNull();
    await previewAndSubmit();
    await waitFor(() => expect(posts('/ai/operator/tasks')).toHaveLength(1));
    expect(posts('/ai/operator/task-drafts')[0]!.inputs.google).toBeNull();
    expect(posts('/ai/operator/tasks')[0]!.inputs.google).toBeNull();
    expect(posts('/ai/operator/tasks')[0]!.inputs.m365).toMatchObject({ userPrincipalName: UPN });

    fireEvent.click(screen.getByTestId('start-recipe-provider-google'));
    expect((screen.getByTestId('start-recipe-google-primary-email') as HTMLInputElement).value).toBe('');
  });

  it('4. mailNickname pre-fills from the UPN local part and stops following it once edited', () => {
    renderForm();
    fireEvent.click(screen.getByTestId('start-recipe-provider-m365'));
    type('start-recipe-upn', 'priya.patel@customer.example');
    expect((screen.getByTestId('start-recipe-mail-nickname') as HTMLInputElement).value).toBe('priya.patel');
    type('start-recipe-mail-nickname', 'ppatel');
    type('start-recipe-upn', 'p.patel@customer.example');
    expect((screen.getByTestId('start-recipe-mail-nickname') as HTMLInputElement).value).toBe('ppatel');
  });

  it('5. usageLocation is never defaulted from the browser locale: empty and required', async () => {
    const lang = vi.spyOn(navigator, 'language', 'get').mockReturnValue('de-DE');
    const langs = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['de-DE']);
    try {
      renderForm();
      fireEvent.click(screen.getByTestId('start-recipe-provider-m365'));
      const field = screen.getByTestId('start-recipe-usage-location') as HTMLInputElement;
      expect(field.value).toBe('');
      expect(field).toBeRequired();
      type('start-recipe-display-name', 'Priya Patel');
      type('start-recipe-upn', UPN);
      fireEvent.click(screen.getByTestId('start-recipe-preview-button'));
      // Client-side validation stops it: nothing is sent without a usage location.
      expect(await screen.findByTestId('start-recipe-invalid')).toBeInTheDocument();
      expect(posts('/ai/operator/task-drafts')).toHaveLength(0);
    } finally {
      lang.mockRestore();
      langs.mockRestore();
    }
  });

  it('6. a SKU the draft could not plan is badged "no seats" and stays selected and submittable', async () => {
    renderForm();
    fillM365();
    addSku(SKU_A);
    addSku(SKU_B);
    await preview();
    // The draft planned SKU_A only; SKU_B had no free seat.
    expect(screen.getByTestId(`start-recipe-sku-no-seats-${SKU_B}`)).toHaveTextContent('No free seat confirmed');
    expect(screen.queryByTestId(`start-recipe-sku-no-seats-${SKU_A}`)).toBeNull();
    expect(screen.getByTestId(`start-recipe-sku-${SKU_B}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('start-recipe-submit'));
    await waitFor(() => expect(posts('/ai/operator/tasks')).toHaveLength(1));
    expect(posts('/ai/operator/tasks')[0]!.inputs.m365.skuIds).toEqual([SKU_A, SKU_B]);
  });

  it('6b. no "no seats" badge when the account itself would not be created (nothing was checked)', async () => {
    draftResponse = () => json({ data: draft({ createPlanPreview: [], provisionPlanPreview: [] }) });
    renderForm();
    fillM365();
    addSku(SKU_B);
    await preview();
    expect(screen.queryByTestId(`start-recipe-sku-no-seats-${SKU_B}`)).toBeNull();
  });

  it('7. a group the draft sends to a technician is badged, and no interaction removes the badge', async () => {
    draftResponse = () => json({ data: draft({
      manualWork: [{ key: `manual_group_add:${GROUP_B}`, label: 'Decide on the group', detail: 'It is a dynamic-membership group.', origin: 'discovery' }],
    }) });
    renderForm();
    fillM365();
    addGroup(GROUP_A);
    addGroup(GROUP_B);
    await preview();
    const badge = screen.getByTestId(`start-recipe-group-needs-technician-${GROUP_B}`);
    expect(badge).toHaveTextContent('A technician will add this one by hand');
    expect(within(badge).queryByRole('button')).toBeNull();
    expect(within(badge).queryByRole('checkbox')).toBeNull();
    fireEvent.click(badge);
    expect(screen.getByTestId(`start-recipe-group-needs-technician-${GROUP_B}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`start-recipe-group-needs-technician-${GROUP_A}`)).toBeNull();
  });

  it('7b. a group option the caller marks needsTechnician is badged before any draft', () => {
    render(
      <StartRecipeForm
        workflow={WORKFLOW}
        orgId={ORG}
        launch={{ kind: 'library' }}
        onboardingOptions={{ m365Groups: [{ id: GROUP_B, label: 'All staff (dynamic)', needsTechnician: true }] }}
      />,
    );
    fireEvent.click(screen.getByTestId('start-recipe-provider-m365'));
    addGroup(GROUP_B);
    expect(screen.getByTestId(`start-recipe-group-needs-technician-${GROUP_B}`)).toBeInTheDocument();
  });

  it('8. the Google block always carries the non-dismissible manual-creation note', () => {
    renderForm();
    fireEvent.click(screen.getByTestId('start-recipe-provider-google'));
    const note = screen.getByTestId('start-recipe-google-manual-note');
    expect(note).toHaveTextContent('Breeze cannot create Google accounts yet.');
    expect(within(note).queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByTestId('start-recipe-provider-google'));
    fireEvent.click(screen.getByTestId('start-recipe-provider-google'));
    expect(screen.getByTestId('start-recipe-google-manual-note')).toBeInTheDocument();
  });

  it('9. choosing a model-after contact calls nothing by itself, and is sent as modelAfterContactId in the draft and the submit', async () => {
    renderForm();
    fillM365();
    expect(screen.getByTestId('start-recipe-model-after-help')).toHaveTextContent('confirm');
    const select = await screen.findByTestId('start-recipe-model-after');
    await waitFor(() => expect(within(select).getByText(/Mo Model/)).toBeInTheDocument());
    const before = fetchMock.mock.calls.length;
    fireEvent.change(select, { target: { value: MODEL } });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(fetchMock.mock.calls.slice(before).filter(([, i]) => (i as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
    // The lists are NOT populated from the model-after person (expansion happens at confirm_details).
    expect(screen.queryByTestId(/^start-recipe-sku-[0-9a-f]{8}-/)).toBeNull();
    await previewAndSubmit();
    await waitFor(() => expect(posts('/ai/operator/tasks')).toHaveLength(1));
    expect(posts('/ai/operator/task-drafts')[0]!.inputs.modelAfterContactId).toBe(MODEL);
    expect(posts('/ai/operator/tasks')[0]!.inputs.modelAfterContactId).toBe(MODEL);
    expect(posts('/ai/operator/tasks')[0]!.inputs.m365.skuIds).toEqual([]);
  });

  it.each([3, 9])('10. a 422 START_AT_BEYOND_DEADLINE lands on the start date with the server\'s %i days, and blocks a resubmit', async (days) => {
    startResponse = () => json({
      error: `The start date is after this task's ${days}-day deadline.`, code: 'START_AT_BEYOND_DEADLINE', deadlineDays: days,
    }, 422);
    renderForm();
    fillM365();
    const later = new Date(Date.now() + (days + 20) * 86_400_000);
    const local = new Date(later.getTime() - later.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    type('start-recipe-start-at', local);
    await previewAndSubmit();
    const err = await screen.findByTestId('start-recipe-start-at-error');
    expect(err).toHaveTextContent(new RegExp(`\\b${days} days\\b`));
    expect(err).not.toHaveTextContent(/\b14 days\b/);
    // Once the server's limit is known, the form holds it inline: still beyond → no submit.
    expect(screen.getByTestId('start-recipe-submit')).toBeDisabled();
    // A start date inside the limit clears it.
    const soon = new Date(Date.now() + 86_400_000);
    type('start-recipe-start-at', new Date(soon.getTime() - soon.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    expect(screen.queryByTestId('start-recipe-start-at-error')).toBeNull();
  });

  it('10b. an empty start date says "provision and hand over now" and sends null', async () => {
    renderForm();
    fillM365();
    expect(screen.getByTestId('start-recipe-start-at-help')).toHaveTextContent('Leave empty to provision and hand over now');
    await previewAndSubmit();
    await waitFor(() => expect(posts('/ai/operator/tasks')).toHaveLength(1));
    expect(posts('/ai/operator/tasks')[0]!.inputs.startAt).toBeNull();
  });

  it('11. the preview shows two labelled stages in plan order, stage 2 provisional', async () => {
    draftResponse = () => json({ data: draft({
      provisionPlanPreview: [
        { ordinal: 1, toolName: 'm365_add_to_group', provider: 'm365', principalLabel: UPN, arguments: { groupId: GROUP_A } },
        { ordinal: 0, toolName: 'm365_assign_license', provider: 'm365', principalLabel: UPN, arguments: { skuIds: [SKU_A] } },
      ],
    }) });
    renderForm();
    fillM365();
    await preview();
    const s1 = screen.getByTestId('start-recipe-preview-stage-1');
    const s2 = screen.getByTestId('start-recipe-preview-stage-2');
    expect(s1).toHaveTextContent('Step 1 — account creation (you approve this first)');
    expect(s1).toHaveTextContent(UPN);
    expect(s2).toHaveTextContent('Step 2 — licences, groups and organizational unit');
    expect(s2).toHaveTextContent('Provisional');
    const items = within(s2).getAllByRole('listitem').map((li) => li.textContent ?? '');
    expect(items[0]).toMatch(/licence/i);
    expect(items[1]).toMatch(/group/i);
  });

  it('12. a 409 OPERATOR_CONTACT_ALREADY_EXISTS links to the existing contact, not a generic error', async () => {
    startResponse = () => json({
      error: 'A contact already uses this person\'s address.', code: 'OPERATOR_CONTACT_ALREADY_EXISTS', existingContactId: EXISTING,
    }, 409);
    renderForm();
    fillM365();
    await previewAndSubmit();
    const link = await screen.findByTestId('start-recipe-existing-contact-link');
    expect(link.getAttribute('href')).toBe(`/organizations/${ORG}#contacts`);
    expect(link.getAttribute('data-contact-id')).toBe(EXISTING);
    expect(screen.getByTestId('start-recipe-error')).toHaveTextContent('A contact already uses this person\'s address.');
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('14. a flag renders verbatim next to its subject', async () => {
    draftResponse = () => json({ data: draft({
      createPlanPreview: [], provisionPlanPreview: [],
      flags: [{ code: 'upn_collision', subject: UPN, detail: 'A Microsoft 365 account already holds this sign-in name, so Breeze would not create one.' }],
    }) });
    renderForm();
    fillM365();
    await preview();
    const near = screen.getByTestId('start-recipe-upn-flags');
    expect(near).toHaveTextContent('A Microsoft 365 account already holds this sign-in name, so Breeze would not create one.');
    expect(screen.getByTestId('start-recipe-preview-flags')).toHaveTextContent(UPN);
    expect(screen.getByTestId('start-recipe-upn-status')).toHaveAttribute('data-state', 'taken');
  });

  it('15. "check availability" uses the draft endpoint; a sign-in name nobody could check reads "could not be checked", never "available"', async () => {
    draftResponse = () => json({ data: draft({
      createPlanPreview: [], provisionPlanPreview: [],
      flags: [{ code: 'm365_collision_check_failed', subject: UPN, detail: 'The provider read failed, so Breeze could not check.' }],
    }) });
    renderForm();
    fillM365();
    fireEvent.click(screen.getByTestId('start-recipe-upn-availability'));
    const status = await screen.findByTestId('start-recipe-upn-status');
    expect(status).toHaveAttribute('data-state', 'unchecked');
    expect(status).toHaveTextContent('could not be checked');
    expect(status).not.toHaveTextContent(/\bavailable\b/i);
    expect(posts('/ai/operator/task-drafts')).toHaveLength(1);
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes('availability'))).toBe(true);
  });

  it('15b. a free sign-in name reads available only when the draft planned its creation', async () => {
    renderForm();
    fillM365();
    fireEvent.click(screen.getByTestId('start-recipe-upn-availability'));
    expect(await screen.findByTestId('start-recipe-upn-status')).toHaveAttribute('data-state', 'available');
  });

  it.each([
    [422, 'OPERATOR_RECIPE_DISABLED', 'The onboarding workflow is not enabled for this deployment'],
    [429, 'OPERATOR_PENDING_CAP_REACHED', 'Too many tasks are waiting for approval in this organization.'],
  ])('17. a %i %s shows the server reason and offers no retry', async (status, code, error) => {
    startResponse = () => json({ error, code }, status);
    renderForm();
    fillM365();
    await previewAndSubmit();
    const alert = await screen.findByTestId('start-recipe-error');
    expect(alert).toHaveTextContent(error);
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('sends no source citation, and a retry of the same body reuses the idempotency key while a changed body mints a new one', async () => {
    let first = true;
    startResponse = () => {
      if (first) { first = false; return json({ error: 'boom' }, 500); }
      return json({ taskId: 'task-new', replayed: false }, 202);
    };
    renderForm({ kind: 'ticket', contactId: MANAGER, personHint: null, label: 'Morgan Manager' });
    fillM365();
    await previewAndSubmit();
    await waitFor(() => expect(posts('/ai/operator/tasks')).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('start-recipe-submit')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('start-recipe-submit'));
    await waitFor(() => expect(posts('/ai/operator/tasks')).toHaveLength(2));
    const [a, b] = posts('/ai/operator/tasks');
    expect(a!.clientIdempotencyKey).toBe(b!.clientIdempotencyKey);
    expect(a).not.toHaveProperty('sourceKind');
    expect(a).not.toHaveProperty('sourceId');
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/operator/tasks/task-new'));
  });

  it('from a ticket: the requester pre-fills the MANAGER with a note, and the new hire\'s name stays empty', async () => {
    renderForm({ kind: 'ticket', contactId: MANAGER, personHint: 'morgan@customer.example', label: 'Morgan Manager' });
    expect((screen.getByTestId('start-recipe-display-name') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('start-recipe-manager-prefill-note')).toHaveTextContent('its requester is set as the manager, not as the new person');
    await waitFor(() => expect((screen.getByTestId('start-recipe-manager') as HTMLSelectElement).value).toBe(MANAGER));
    fillM365();
    await preview();
    expect(posts('/ai/operator/task-drafts')[0]!.inputs.managerContactId).toBe(MANAGER);
    expect(posts('/ai/operator/task-drafts')[0]!.inputs.displayName).toBe('Priya Patel');
  });

  it('a change after the preview makes it stale and disables submit', async () => {
    renderForm();
    fillM365();
    await preview();
    expect(screen.getByTestId('start-recipe-submit')).not.toBeDisabled();
    type('start-recipe-display-name', 'Priya P. Patel');
    expect(screen.getByTestId('start-recipe-preview-stale')).toBeInTheDocument();
    expect(screen.getByTestId('start-recipe-submit')).toBeDisabled();
  });

  it('an SKU id that is not a GUID is refused client-side and never sent', async () => {
    renderForm();
    fillM365();
    addSku('E5');
    expect(screen.getByTestId('start-recipe-sku-input-error')).toBeInTheDocument();
    expect(screen.queryByTestId('start-recipe-sku-E5')).toBeNull();
  });
});

// Review round (PR #10128) — each case pins a finding.
describe('StartRecipeForm — identity_onboarding review fixes', () => {
  it('Enter in an add box adds the entry and never submits the form', async () => {
    renderForm();
    fillM365();
    await preview();
    expect(screen.getByTestId('start-recipe-submit')).not.toBeDisabled();
    type('start-recipe-group-input', GROUP_B);
    fireEvent.keyDown(screen.getByTestId('start-recipe-group-input'), { key: 'Enter', code: 'Enter' });
    fireEvent.submit(screen.getByTestId('start-recipe-form'), { submitter: screen.getByTestId('start-recipe-group-input') });
    expect(screen.getByTestId(`start-recipe-group-${GROUP_B}`)).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(posts('/ai/operator/tasks')).toHaveLength(0);
  });

  it('a failed re-preview of unchanged inputs drops the old preview instead of claiming the form changed', async () => {
    renderForm();
    fillM365();
    await preview();
    draftResponse = () => json({ error: 'boom' }, 500);
    fireEvent.click(screen.getByTestId('start-recipe-preview-button'));
    await screen.findByTestId('start-recipe-error');
    expect(screen.queryByTestId('start-recipe-preview-stale')).toBeNull();
    expect(screen.queryByTestId('start-recipe-preview')).toBeNull();
    expect(screen.getByTestId('start-recipe-submit')).toBeDisabled();
  });

  it('a degraded M365 create reads "created by hand", not "could not be checked" and never "available"', async () => {
    draftResponse = () => json({ data: draft({
      createPlanPreview: [], provisionPlanPreview: [],
      workflow: { ...WORKFLOW, readiness: 'setup_required', degradedEffects: ['m365_create_user'] },
    }) });
    renderForm();
    fillM365();
    fireEvent.click(screen.getByTestId('start-recipe-upn-availability'));
    const status = await screen.findByTestId('start-recipe-upn-status');
    expect(status).toHaveAttribute('data-state', 'manual');
    expect(status).not.toHaveTextContent(/\bavailable\b/i);
  });

  it.each([
    ['the licence tool is degraded', { workflow: { ...WORKFLOW, degradedEffects: ['m365_assign_license'] } }],
    ['the licence read needed consent', { flags: [{ code: 'm365_consent_upgrade_required', subject: UPN, detail: 'Consent needed.' }] }],
  ])('no "no seats" badge when %s (nobody weighed the seat)', async (_label, overrides) => {
    draftResponse = () => json({ data: draft({ provisionPlanPreview: [], ...(overrides as Partial<Draft>) }) });
    renderForm();
    fillM365();
    addSku(SKU_B);
    await preview();
    expect(screen.queryByTestId(`start-recipe-sku-no-seats-${SKU_B}`)).toBeNull();
  });

  it('a deadline refusal the client clock does not reproduce still reports the server reason', async () => {
    startResponse = () => json({ error: 'The start date is after this task\'s 3-day deadline.', code: 'START_AT_BEYOND_DEADLINE', deadlineDays: 3 }, 422);
    renderForm();
    fillM365();
    await previewAndSubmit();
    // startAt is empty, so the client cannot reproduce "beyond 3 days": the reason must still show.
    expect(await screen.findByTestId('start-recipe-error')).toBeInTheDocument();
    expect(screen.queryByTestId('start-recipe-start-at-error')).toBeNull();
  });

  it('a half-typed start date blocks the preview instead of becoming "start now"', async () => {
    renderForm();
    fillM365();
    const input = screen.getByTestId('start-recipe-start-at') as HTMLInputElement;
    Object.defineProperty(input, 'validity', { configurable: true, get: () => ({ badInput: true, valid: false }) });
    // Typed into an empty field: the value stays '' (no change event), so blur is what catches it.
    fireEvent.blur(input);
    expect(screen.getByTestId('start-recipe-start-at-error')).toHaveTextContent('Enter a full start date and time');
    fireEvent.click(screen.getByTestId('start-recipe-preview-button'));
    expect(await screen.findByTestId('start-recipe-invalid')).toBeInTheDocument();
    expect(posts('/ai/operator/task-drafts')).toHaveLength(0);
  });

  it('flags are labelled by what was checked, so two read failures with the same text can be told apart', async () => {
    draftResponse = () => json({ data: draft({ flags: [
      { code: 'm365_seats_read_failed', subject: UPN, detail: 'The provider read failed, so Breeze could not check.' },
    ] }) });
    renderForm();
    fillM365();
    await preview();
    expect(screen.getByTestId('start-recipe-upn-flags')).toHaveTextContent('Licence seat check');
    expect(screen.getByTestId('start-recipe-preview-flags')).toHaveTextContent('Licence seat check');
  });

  it('client-side problems are named by field, not as raw schema messages', async () => {
    renderForm();
    type('start-recipe-display-name', 'Priya Patel');
    fireEvent.click(screen.getByTestId('start-recipe-preview-button'));
    const invalid = await screen.findByTestId('start-recipe-invalid');
    expect(invalid).toHaveTextContent('Turn on at least one account to create.');
    expect(invalid).not.toHaveTextContent(/Invalid|pattern|Expected/);
  });

  it('from a ticket the requester never becomes the model-after person', async () => {
    renderForm({ kind: 'ticket', contactId: MANAGER, personHint: null, label: 'Morgan Manager' });
    expect((screen.getByTestId('start-recipe-model-after') as HTMLSelectElement).value).toBe('');
    fillM365();
    await preview();
    expect(posts('/ai/operator/task-drafts')[0]!.inputs.modelAfterContactId).toBeNull();
  });

  it('a failed site list says so and offers a retry', async () => {
    const base = fetchMock.getMockImplementation()!;
    let sitesFail = true;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).startsWith('/orgs/sites')) return sitesFail ? json({ error: 'x' }, 500) : json({ data: [{ id: 'site-1', name: 'HQ' }] });
      return base(input, init);
    });
    renderForm();
    const err = await screen.findByTestId('start-recipe-site-error');
    sitesFail = false;
    fireEvent.click(within(err).getByRole('button'));
    await waitFor(() => expect(within(screen.getByTestId('start-recipe-site')).getByText('HQ')).toBeInTheDocument());
  });
});
