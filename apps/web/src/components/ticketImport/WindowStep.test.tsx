import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { fetchMock, mintMock, toastMock, userState } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mintMock: vi.fn(),
  toastMock: vi.fn(),
  userState: { id: 'user-me' as string },
}));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchMock,
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) => selector({ user: { id: userState.id } }),
}));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintMock,
  StepUpMintError: class StepUpMintError extends Error {},
}));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import { migrationWindowOpenStepUpResourceSchema } from '@breeze/shared';
import WindowStep, { DEFAULT_WRITES_PER_HOUR, windowResource } from './WindowStep';
import { ORG_A, ORG_B, PARTNER_ID, PRINCIPAL_ID, json, migrationWindow, sourceDetail } from './testFixtures';

const source = sourceDetail({
  mappings: {
    orgs: [
      { sourceOrgKey: '2', sourceOrgName: 'Globex', orgId: ORG_B },
      { sourceOrgKey: '1', sourceOrgName: 'Acme', orgId: ORG_A },
      { sourceOrgKey: null, sourceOrgName: null, orgId: ORG_A },
    ],
    categories: [],
  },
});
const names: Record<string, string> = { [ORG_A]: 'Acme', [ORG_B]: 'Globex' };
const nameOfOrg = (id: string) => names[id] ?? id;

const windowPosts = () => fetchMock.mock.calls
  .filter(([url, init]) => url === '/migration-windows' && (init as { method?: string })?.method === 'POST')
  .map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);

/** Answers each POST /migration-windows in turn; factor discovery says TOTP. */
function respond(...answers: Response[]) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/users/me') return json(200, { mfaMethod: 'totp' });
    if (url === '/auth/passkeys') return json(200, []);
    if (url === '/migration-windows' && init?.method === 'POST') return answers.shift() ?? json(500, { error: 'unexpected' });
    return json(404, { error: 'unrouted' });
  });
}

const stepUpRequired = () => json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
const opened = () => json(201, { data: migrationWindow() });

function renderStep(over: Partial<Parameters<typeof WindowStep>[0]> = {}) {
  const onOpened = vi.fn();
  render(<WindowStep source={source} openWindow={null} otherOpenWindow={null} partnerId={PARTNER_ID}
    nameOfOrg={nameOfOrg} onOpened={onOpened} onContinue={vi.fn()} {...over} />);
  return { onOpened };
}

beforeEach(() => {
  vi.clearAllMocks();
  userState.id = 'user-me';
  mintMock.mockResolvedValue('grant-1');
});

describe('WindowStep (#8313 W6)', () => {
  it('opens over the mapped orgs (fallback included, once each) without a grant when the server asks for none', async () => {
    respond(opened());
    const { onOpened } = renderStep();
    expect(screen.getByTestId('ticket-import-window-orgs')).toHaveTextContent('Acme, Globex');
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    const [body] = windowPosts();
    expect(body).toMatchObject({
      principalId: PRINCIPAL_ID,
      orgIds: [ORG_A, ORG_B].sort(),
      writesPerHour: DEFAULT_WRITES_PER_HOUR,
      sourceLabel: 'Zammad',
    });
    expect(new Date(body!.endsAt as string).toISOString()).toBe(body!.endsAt);
    expect(body).not.toHaveProperty('stepUpGrant');
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('asks for the second factor on STEP_UP_REQUIRED and mints migration_window_open for exactly the window it sends', async () => {
    respond(stepUpRequired(), opened());
    const { onOpened } = renderStep();
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    const code = await screen.findByTestId('ticket-import-window-stepup-code');
    // A step-up request is not a failure: no error toast.
    expect(toastMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('ticket-import-window-open-submit')).toBeDisabled();
    fireEvent.change(code, { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());

    expect(mintMock).toHaveBeenCalledTimes(1);
    const minted = mintMock.mock.calls[0]![0] as { operation: string; resource: Record<string, unknown>; reauth: unknown };
    expect(minted.operation).toBe('migration_window_open');
    expect(minted.reauth).toEqual({ method: 'totp', code: '123456' });
    const [first, second] = windowPosts();
    expect(first).not.toHaveProperty('stepUpGrant');
    expect(second!.stepUpGrant).toBe('grant-1');
    expect(minted.resource).toEqual({
      partnerId: PARTNER_ID,
      principalId: second!.principalId,
      orgIds: second!.orgIds,
      endsAt: second!.endsAt,
      writesPerHour: second!.writesPerHour,
    });
  });

  it('holds a grant across a refusal that did not spend it, and reuses it for the same window', async () => {
    respond(
      stepUpRequired(),
      json(409, { error: 'already open', code: 'MIGRATION_WINDOW_ALREADY_OPEN' }),
      opened(),
    );
    const { onOpened } = renderStep();
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    fireEvent.change(await screen.findByTestId('ticket-import-window-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    expect(await screen.findByTestId('ticket-import-window-error')).toHaveTextContent('Another migration window is open. Close it first.');
    expect(screen.queryByTestId('ticket-import-window-stepup')).toBeNull();

    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(windowPosts().map((b) => b.stepUpGrant ?? null)).toEqual([null, 'grant-1', 'grant-1']);
    // The refusal was shown inline only: no toast on top of it.
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('drops the held grant when the window changes, because the grant is bound to it', async () => {
    respond(
      stepUpRequired(),
      json(403, { error: 'org', code: 'MIGRATION_WINDOW_ORG_NOT_ALLOWED' }),
      stepUpRequired(),
    );
    renderStep();
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    fireEvent.change(await screen.findByTestId('ticket-import-window-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    await screen.findByTestId('ticket-import-window-error');

    fireEvent.change(screen.getByTestId('ticket-import-window-rate'), { target: { value: '20000' } });
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    await screen.findByTestId('ticket-import-window-stepup-code');
    const sent = windowPosts();
    expect(sent).toHaveLength(3);
    expect(sent[2]).not.toHaveProperty('stepUpGrant');
    expect(sent[2]!.writesPerHour).toBe(20000);
  });

  it('a freshly minted grant the server refuses asks for a new code', async () => {
    respond(stepUpRequired(), stepUpRequired());
    renderStep();
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    fireEvent.change(await screen.findByTestId('ticket-import-window-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    expect(await screen.findByTestId('ticket-import-window-error')).toHaveTextContent('The confirmation expired. Enter a new code.');
    expect(screen.getByTestId('ticket-import-window-stepup-code')).toHaveValue('');
  });

  it('a failed mint stays on the prompt and sends nothing', async () => {
    respond(stepUpRequired());
    mintMock.mockRejectedValueOnce(new Error('Invalid code'));
    renderStep();
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    fireEvent.change(await screen.findByTestId('ticket-import-window-stepup-code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('ticket-import-window-open-submit'));
    expect(await screen.findByTestId('ticket-import-window-error')).toHaveTextContent('Invalid code');
    expect(windowPosts()).toHaveLength(1);
  });

  it('only the principal owner can open it', () => {
    userState.id = 'someone-else';
    renderStep();
    expect(screen.getByTestId('ticket-import-window-not-owner')).toBeInTheDocument();
    expect(screen.getByTestId('ticket-import-window-open-submit')).toBeDisabled();
  });

  it('shows the open window and another principal\'s open window', () => {
    renderStep({ otherOpenWindow: migrationWindow({ principalId: 'other', sourceLabel: 'Freshdesk' }) });
    expect(screen.getByTestId('ticket-import-window-other-open')).toHaveTextContent('Freshdesk');
  });

  it('with its window open, offers to continue', () => {
    renderStep({ openWindow: migrationWindow() });
    expect(screen.getByTestId('ticket-import-window-open')).toBeInTheDocument();
    expect(screen.queryByTestId('ticket-import-window-open-submit')).toBeNull();
  });

  it('builds exactly the step-up resource the server validates, nothing more', () => {
    const resource = windowResource({ partnerId: PARTNER_ID, principalId: PRINCIPAL_ID, orgIds: [ORG_B, ORG_A], endsAt: '2026-11-15T08:00:00.000Z', writesPerHour: 6000 });
    expect(migrationWindowOpenStepUpResourceSchema.strict().parse(resource)).toEqual(resource);
    expect(resource.orgIds).toEqual([ORG_A, ORG_B].sort());
  });
});
