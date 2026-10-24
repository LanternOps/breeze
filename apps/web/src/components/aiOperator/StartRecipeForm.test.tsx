import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_OFFBOARDING_EFFECT_TOGGLES,
  identityOffboardingEffectsSchema,
  type AiOperatorIdentityTaskDraftDto,
  type AiOperatorWorkflowDto,
} from '@breeze/shared';

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
const CONTACT = '33333333-3333-4333-8333-333333333333';
const CAND_A = '44444444-4444-4444-8444-444444444444';
const CAND_B = '55555555-5555-4555-8555-555555555555';
const HEIR = '66666666-6666-4666-8666-666666666666';
const DEV = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

const WORKFLOW: AiOperatorWorkflowDto = {
  recipeKey: 'identity_offboarding', recipeVersion: 9, name: 'Offboard a person', summary: 's',
  gateClass: 'deterministic', targetKinds: ['contact'], readiness: 'ready', missingCapabilities: [],
  alwaysManualCapabilities: [], manualStepCount: 0, degradedEffects: [], agentId: null, agentKind: 'helpdesk',
};

function draft(overrides: Partial<AiOperatorIdentityTaskDraftDto> = {}): AiOperatorIdentityTaskDraftDto {
  return {
    recipeKey: 'identity_offboarding', recipeVersion: 9, input: {} as AiOperatorIdentityTaskDraftDto['input'], workflow: WORKFLOW,
    person: { resolved: { id: CONTACT, name: 'Dana Smith', email: 'dana@example.com' }, candidates: [] },
    plannedEffectTools: ['google_set_vacation', 'm365_set_auto_reply', 'm365_disable_user', 'google_suspend_user'],
    degradedEffectTools: ['m365_remove_license'],
    manualWork: [{ key: 'collect_hardware', label: 'Collect Dana’s laptop', detail: 'd', origin: 'always' }],
    ...overrides,
  };
}

type Handler = (url: string, init?: RequestInit) => Response | undefined;
let extra: Handler = () => undefined;
let draftResponse: () => Response = () => json({ data: draft() });
let startResponse: () => Response = () => json({ taskId: 'task-new', replayed: false }, 202);

beforeEach(() => {
  fetchMock.mockReset();
  navigateTo.mockReset();
  showToast.mockReset();
  extra = () => undefined;
  draftResponse = () => json({ data: draft() });
  startResponse = () => json({ taskId: 'task-new', replayed: false }, 202);
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const hit = extra(url, init as RequestInit | undefined);
    if (hit) return hit;
    if (url === '/ai/operator/task-drafts') return draftResponse();
    if (url === '/ai/operator/tasks') return startResponse();
    if (url.startsWith(`/orgs/organizations/${ORG}/contacts`)) {
      return json({ data: [{ id: HEIR, name: 'Lee Inheritor', email: 'lee@example.com', phone: null, siteId: null }], pagination: { total: 1 } });
    }
    if (url.startsWith('/devices')) {
      return json({ data: Array.from({ length: 12 }, (_, i) => ({ id: DEV(i), hostname: `WKS-${i}`, displayName: null, lastUser: 'dana' })) });
    }
    return json({ error: `unexpected ${url}` }, 404);
  });
});
afterEach(() => vi.clearAllMocks());

const bodies = (url: string) => fetchMock.mock.calls
  .filter(([u, i]) => String(u) === url && (i as RequestInit | undefined)?.method === 'POST')
  .map(([, i]) => JSON.parse(String((i as RequestInit).body)) as Record<string, any>);

async function preview() {
  fireEvent.click(screen.getByTestId('start-recipe-preview-button'));
  return screen.findByTestId('start-recipe-preview');
}

describe('StartRecipeForm — person', () => {
  it('from a contact: the person is read-only and only contactId is sent', async () => {
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'contact', contactId: CONTACT, label: 'Dana Smith' }} />);
    const person = screen.getByTestId('start-recipe-person');
    expect(person).toHaveTextContent('Dana Smith');
    expect(within(person).queryByRole('textbox')).toBeNull();
    expect(screen.queryByTestId('start-recipe-person-use-hint')).toBeNull();
    await preview();
    expect(bodies('/ai/operator/task-drafts')[0]!.inputs).toMatchObject({ contactId: CONTACT, personHint: null });
  });

  it('library: a free-text hint; candidates are offered but never auto-selected, and picking one replaces the hint', async () => {
    draftResponse = () => json({ data: draft({ person: { resolved: null, candidates: [
      { id: CAND_A, name: 'Dana Smith', email: 'dana.s@example.com' },
      { id: CAND_B, name: 'Dana Smythe', email: 'dana.y@example.com' },
    ] } }) });
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'library' }} />);
    fireEvent.change(screen.getByTestId('start-recipe-person-hint'), { target: { value: 'Dana' } });
    const pv = await preview();
    expect(bodies('/ai/operator/task-drafts')[0]!.inputs).toMatchObject({ personHint: 'Dana', contactId: null });
    expect(pv).toHaveTextContent('No single contact matches');
    const a = screen.getByTestId(`start-recipe-candidate-${CAND_A}`) as HTMLInputElement;
    const b = screen.getByTestId(`start-recipe-candidate-${CAND_B}`) as HTMLInputElement;
    expect(a.checked).toBe(false);
    expect(b.checked).toBe(false);
    expect(screen.getByTestId('start-recipe-submit')).toBeDisabled();

    fireEvent.click(a);
    // Choosing a contact makes the person a contact; the hint is disabled, never sent alongside.
    expect(screen.getByTestId('start-recipe-person')).toHaveTextContent('Dana Smith');
    expect(screen.queryByTestId('start-recipe-person-hint')).toBeNull();
    await preview();
    const second = bodies('/ai/operator/task-drafts')[1]!.inputs;
    expect(second).toMatchObject({ contactId: CAND_A, personHint: null });
  });

  it('submits the RESOLVED contact the preview showed, not the typed hint', async () => {
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'library' }} />);
    fireEvent.change(screen.getByTestId('start-recipe-person-hint'), { target: { value: 'dana@example.com' } });
    expect(await preview()).toHaveTextContent('Will offboard: Dana Smith');
    fireEvent.click(screen.getByTestId('start-recipe-submit'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/operator/tasks/task-new'));
    expect(bodies('/ai/operator/tasks')[0]!.inputs).toMatchObject({ contactId: CONTACT, personHint: null });
  });
});

describe('StartRecipeForm — inheritor', () => {
  it('contact and address are mutually exclusive in the UI and on the wire', async () => {
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'contact', contactId: CONTACT, label: 'Dana Smith' }} />);
    fireEvent.click(screen.getByTestId('start-recipe-inheritor-mode-address'));
    fireEvent.change(screen.getByTestId('start-recipe-inheritor-address'), { target: { value: 'boss@example.com' } });
    expect(screen.queryByTestId('start-recipe-inheritor-contact')).toBeNull();
    fireEvent.click(screen.getByTestId('start-recipe-inheritor-mode-contact'));
    const select = await screen.findByTestId('start-recipe-inheritor-contact');
    await waitFor(() => expect(within(select).getByText(/Lee Inheritor/)).toBeInTheDocument());
    fireEvent.change(select, { target: { value: HEIR } });
    expect(screen.queryByTestId('start-recipe-inheritor-address')).toBeNull();
    await preview();
    const inputs = bodies('/ai/operator/task-drafts')[0]!.inputs;
    expect(inputs.inheritorContactId).toBe(HEIR);
    expect(inputs.forwardTo).toBeNull();
  });

  it('the generated auto-reply names the chosen inheritor until the technician edits it', async () => {
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'contact', contactId: CONTACT, label: 'Dana Smith' }} />);
    const reply = screen.getByTestId('start-recipe-auto-reply') as HTMLTextAreaElement;
    expect(reply.value).toContain('Dana Smith is no longer with the company');
    fireEvent.click(screen.getByTestId('start-recipe-inheritor-mode-address'));
    fireEvent.change(screen.getByTestId('start-recipe-inheritor-address'), { target: { value: 'boss@example.com' } });
    expect(reply.value).toContain('Please contact boss@example.com');
    fireEvent.change(reply, { target: { value: 'Custom text' } });
    fireEvent.change(screen.getByTestId('start-recipe-inheritor-address'), { target: { value: 'other@example.com' } });
    expect(reply.value).toBe('Custom text');
  });
});

describe('StartRecipeForm — options', () => {
  it('renders the eight toggles with the schema defaults (not restated here)', () => {
    const defaults = identityOffboardingEffectsSchema.parse({});
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'library' }} />);
    for (const toggle of IDENTITY_OFFBOARDING_EFFECT_TOGGLES) {
      expect((screen.getByTestId(`start-recipe-effect-${toggle}`) as HTMLInputElement).checked).toBe(defaults[toggle]);
    }
    expect(screen.getByTestId('start-recipe-effect-wipeMobile').closest('label'))
      .toHaveTextContent('Removes the work account from enrolled phones. The device itself is not erased.');
  });

  it('states the keep-mailbox consequence verbatim, and the cutoff in words', () => {
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'library' }} />);
    expect(screen.getByTestId('start-recipe-keep-mailbox').closest('div')).toHaveTextContent(
      "Breeze will leave the Microsoft 365 licence in place and add a manual step to convert the mailbox to shared. Removing the licence first would start the mailbox's 30-day deletion clock.",
    );
    expect(screen.getByTestId('start-recipe-cutoff-help')).toHaveTextContent('Empty means start now');
  });

  it('devices: none pre-checked, no match basis claimed, "selected by you" only once chosen, capped at 10', async () => {
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'library' }} />);
    const first = await screen.findByTestId(`start-recipe-device-${DEV(0)}`) as HTMLInputElement;
    expect(first.checked).toBe(false);
    const devices = screen.getByTestId('start-recipe-devices');
    expect(devices).not.toHaveTextContent('Selected by you');
    expect(devices).not.toHaveTextContent(/last signed-in|matched|dana/i);
    for (let i = 0; i < 10; i += 1) fireEvent.click(screen.getByTestId(`start-recipe-device-${DEV(i)}`));
    expect(screen.getByTestId(`start-recipe-device-row-${DEV(0)}`)).toHaveTextContent('Selected by you');
    expect(screen.getByTestId(`start-recipe-device-${DEV(10)}`)).toBeDisabled();
    fireEvent.change(screen.getByTestId('start-recipe-person-hint'), { target: { value: 'Dana' } });
    await preview();
    expect(bodies('/ai/operator/task-drafts')[0]!.inputs.deviceIds).toHaveLength(10);
  });
});

describe('StartRecipeForm — preview and submit', () => {
  it('groups the preview by provider, unnumbered, and lists hand work separately', async () => {
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'contact', contactId: CONTACT, label: 'Dana Smith' }} />);
    const pv = await preview();
    const google = within(pv).getByTestId('start-recipe-preview-provider-google');
    const m365 = within(pv).getByTestId('start-recipe-preview-provider-m365');
    expect(google).toHaveTextContent('Set the Gmail auto-reply');
    expect(google).toHaveTextContent('Suspend the Google account');
    expect(m365).toHaveTextContent('Block Microsoft 365 sign-in');
    expect(pv.querySelector('ol')).toBeNull();
    expect(pv).toHaveTextContent('not in order');
    expect(within(pv).getByTestId('start-recipe-preview-degraded')).toHaveTextContent('Remove Microsoft 365 licences');
    expect(within(pv).getByTestId('start-recipe-preview-manual')).toHaveTextContent('Collect Dana’s laptop');
    expect(pv).toHaveTextContent('The task opens its own ticket');
  });

  it('a change after the preview disables submit until the preview is redone', async () => {
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'contact', contactId: CONTACT, label: 'Dana Smith' }} />);
    await preview();
    expect(screen.getByTestId('start-recipe-submit')).toBeEnabled();
    fireEvent.click(screen.getByTestId('start-recipe-keep-mailbox'));
    expect(screen.getByTestId('start-recipe-submit')).toBeDisabled();
    expect(screen.getByTestId('start-recipe-preview-stale')).toBeInTheDocument();
  });

  it('submits mode live with the Library version and ONE key across retries, never a source citation', async () => {
    startResponse = () => json({ error: 'temporarily unavailable' }, 503);
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'ticket', contactId: CONTACT, personHint: null, label: 'Dana Smith' }} />);
    await preview();
    fireEvent.click(screen.getByTestId('start-recipe-submit'));
    await waitFor(() => expect(bodies('/ai/operator/tasks')).toHaveLength(1));
    startResponse = () => json({ taskId: 'task-new', replayed: false }, 202);
    await waitFor(() => expect(screen.getByTestId('start-recipe-submit')).toBeEnabled());
    fireEvent.click(screen.getByTestId('start-recipe-submit'));
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/operator/tasks/task-new'));
    const [first, second] = bodies('/ai/operator/tasks');
    expect(first!.mode).toBe('live');
    expect(first!.recipeVersion).toBe(9);
    expect(first!.clientIdempotencyKey).toBe(second!.clientIdempotencyKey);
    expect(first).not.toHaveProperty('sourceKind');
    expect(first).not.toHaveProperty('sourceId');
  });

  it('a 409 duplicate links to the running task rather than a generic error', async () => {
    startResponse = () => json({ error: 'An offboarding task is already running for this person.', code: 'OPERATOR_DUPLICATE_LIVE_TASK', taskId: 'task-live' }, 409);
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'contact', contactId: CONTACT, label: 'Dana Smith' }} />);
    await preview();
    fireEvent.click(screen.getByTestId('start-recipe-submit'));
    const link = await screen.findByTestId('start-recipe-duplicate-link');
    expect(link).toHaveAttribute('href', '/operator/tasks/task-live');
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('a 409 without a task id shows the server message', async () => {
    startResponse = () => json({ error: 'An offboarding task is already running for this person.', code: 'OPERATOR_DUPLICATE_LIVE_TASK', taskId: null }, 409);
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'contact', contactId: CONTACT, label: 'Dana Smith' }} />);
    await preview();
    fireEvent.click(screen.getByTestId('start-recipe-submit'));
    expect(await screen.findByTestId('start-recipe-error')).toHaveTextContent('already running for this person');
    expect(screen.queryByTestId('start-recipe-duplicate-link')).toBeNull();
  });

  it('shows the server refusal for a site-restricted caller, verbatim', async () => {
    draftResponse = () => json({
      error: 'Offboarding acts on organization-wide identity accounts; site-restricted users cannot start it.',
      code: 'SITE_RESTRICTED',
    }, 403);
    render(<StartRecipeForm workflow={WORKFLOW} orgId={ORG} launch={{ kind: 'contact', contactId: CONTACT, label: 'Dana Smith' }} />);
    fireEvent.click(screen.getByTestId('start-recipe-preview-button'));
    expect(await screen.findByTestId('start-recipe-error')).toHaveTextContent('site-restricted users cannot start it');
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
