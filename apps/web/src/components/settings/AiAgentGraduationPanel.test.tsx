import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiAgentDto,
  AiAgentGraduationByOrgDto,
  AiAgentGraduationDto,
  AiAgentGraduationRowDto,
  AiAgentMode,
} from '@breeze/shared';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const scopeState = { orgId: null as string | null, isPartnerScope: true };

const orgScopeOf = () =>
  scopeState.orgId === null
    ? { ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null }
    : { ready: true, status: 'resolved', scope: 'org', orgId: scopeState.orgId, org: null, error: null };

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
// Resolved relative to THIS file (components/settings/), the same module
// runAction.ts reaches via '../components/shared/Toast' — vitest matches on the
// resolved path, so this also intercepts runAction's own import (established
// pattern: AiAgentSchedulesSection.test.tsx).
vi.mock('../shared/Toast', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/hooks/useOrgScope', () => ({ useOrgScope: () => orgScopeOf() }));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({
    isPartnerScope: scopeState.isPartnerScope,
    defaultOwnerScope: scopeState.isPartnerScope && scopeState.orgId === null ? 'partner' : 'organization',
  }),
}));

import AiAgentGraduationPanel from './AiAgentGraduationPanel';
import AiAgentForm from './AiAgentForm';

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/**
 * Deliberately NON-UNIFORM: every numeric column carries a different value, so
 * a wrong-column render (verified read from `failed`, say) fails instead of
 * passing on coincidence.
 */
function row(overrides: Partial<AiAgentGraduationRowDto> = {}): AiAgentGraduationRowDto {
  return {
    opKey: 'manage_devices:restart_device',
    namespace: 'policy_key',
    state: 'eligible',
    window: { executed: 41, verified: 22, failed: 3, recurred: 7, firstVerifiedAt: '2026-07-04T09:15:00.000Z' },
    blockedReason: null,
    promotedAt: null,
    demotedAt: null,
    demoteReason: null,
    ...overrides,
  };
}

function dto(overrides: Partial<AiAgentGraduationDto> = {}): AiAgentGraduationDto {
  return {
    version: 1,
    agentId: 'agent-1',
    ownerScope: 'partner',
    rows: [row()],
    actOpReliability: [
      { opKey: 'devices.restart', executed: 61, verified: 52, failed: 4, recurred: 9 },
    ],
    promoteThreshold: 20,
    policyDecideEnabled: true,
    ...overrides,
  };
}

function mockGraduation(payload: unknown, promoteResponse?: () => Response) {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      return Promise.resolve(promoteResponse ? promoteResponse() : json({ intentId: 'intent-9' }, true, 201));
    }
    if (typeof url === 'string' && url.startsWith('/ai/agents/graduation')) {
      return Promise.resolve(json(payload));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

const orgProps = { orgId: 'org-1', kind: 'patch' as const, isPartnerScope: false };

function lastMutation() {
  const call = fetchWithAuth.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method).at(-1);
  const init = call?.[1] as RequestInit | undefined;
  return {
    url: call?.[0] as string | undefined,
    method: init?.method,
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
  };
}

async function clickPromoteAndConfirm(opKey: string) {
  fireEvent.click(await screen.findByTestId(`ai-agent-graduation-promote-${opKey}`));
  fireEvent.click(await screen.findByTestId('ai-agent-graduation-promote-confirm'));
}

beforeEach(() => {
  scopeState.orgId = null;
  scopeState.isPartnerScope = true;
});

describe('AiAgentGraduationPanel — single-org read', () => {
  it('renders each graduation column from its own field', async () => {
    mockGraduation(dto());
    render(<AiAgentGraduationPanel {...orgProps} />);

    const tr = await screen.findByTestId('ai-agent-graduation-row-manage_devices:restart_device');
    const cells = within(tr).getAllByRole('cell').map((cell) => cell.textContent ?? '');
    expect(cells[0]).toContain('manage_devices:restart_device');
    // verified / promoteThreshold, then failed, then recurred — distinct values,
    // so a swapped column cannot pass.
    expect(cells[2]).toContain('22');
    expect(cells[2]).toContain('20');
    expect(cells[3]).toBe('3');
    expect(cells[4]).toBe('7');
  });

  // The single-org read resolves ONE org's merged threshold, so the denominator
  // is true for every row here — and the byOrg caveat must not leak onto it.
  it('keeps the verified-of-threshold denominator and omits the per-org caveat', async () => {
    mockGraduation(dto());
    render(<AiAgentGraduationPanel {...orgProps} />);

    await screen.findByTestId('ai-agent-graduation-row-manage_devices:restart_device');
    expect(screen.queryByTestId('ai-agent-graduation-threshold-per-org-note')).toBeNull();
  });

  it('sends orgId and kind on the graduation read', async () => {
    mockGraduation(dto());
    render(<AiAgentGraduationPanel {...orgProps} />);
    await screen.findByTestId('ai-agent-graduation-panel');
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/agents/graduation?orgId=org-1&kind=patch');
  });

  it('renders act-op reliability rows from their own fields', async () => {
    mockGraduation(dto());
    render(<AiAgentGraduationPanel {...orgProps} />);

    const tr = await screen.findByTestId('ai-agent-act-reliability-row-devices.restart');
    const cells = within(tr).getAllByRole('cell').map((cell) => cell.textContent ?? '');
    expect(cells[0]).toContain('devices.restart');
    expect(cells[1]).toBe('61');
    expect(cells[2]).toBe('52');
    expect(cells[3]).toBe('4');
    expect(cells[4]).toBe('9');
  });

  it('gives each blocked reason its own distinct localized string', async () => {
    const reasons = [
      'needs_partner_baseline',
      'below_threshold',
      'too_recent',
      'has_failures',
      'not_policy_decidable',
    ] as const;
    mockGraduation(dto({
      rows: reasons.map((reason) => row({ opKey: `t:${reason}`, state: 'tracking', blockedReason: reason })),
    }));
    render(<AiAgentGraduationPanel {...orgProps} />);

    await screen.findByTestId('ai-agent-graduation-row-t:needs_partner_baseline');
    const rendered = reasons.map((reason) => {
      const cells = within(screen.getByTestId(`ai-agent-graduation-row-t:${reason}`)).getAllByRole('cell');
      return cells[cells.length - 1].textContent ?? '';
    });
    for (const text of rendered) {
      expect(text.length).toBeGreaterThan(0);
      // A missing catalog entry renders the raw key path.
      expect(text).not.toContain('aiAgentsPage.graduation');
    }
    expect(new Set(rendered).size).toBe(reasons.length);
  });
});

describe('AiAgentGraduationPanel — promote affordance', () => {
  it.each(['tracking', 'promoted', 'demoted'] as const)('hides Promote on a %s row', async (state) => {
    mockGraduation(dto({ rows: [row({ state })] }));
    render(<AiAgentGraduationPanel {...orgProps} />);

    await screen.findByTestId('ai-agent-graduation-row-manage_devices:restart_device');
    expect(screen.queryByTestId('ai-agent-graduation-promote-manage_devices:restart_device')).toBeNull();
  });

  it('shows Promote on an eligible row when policy-decide is on', async () => {
    mockGraduation(dto());
    render(<AiAgentGraduationPanel {...orgProps} />);
    expect(await screen.findByTestId('ai-agent-graduation-promote-manage_devices:restart_device')).toBeTruthy();
    expect(screen.queryByTestId('ai-agent-graduation-readonly-note')).toBeNull();
  });

  it('hides Promote on an eligible row and shows the read-only note when policy-decide is off', async () => {
    mockGraduation(dto({ policyDecideEnabled: false }));
    render(<AiAgentGraduationPanel {...orgProps} />);

    await screen.findByTestId('ai-agent-graduation-row-manage_devices:restart_device');
    expect(screen.queryByTestId('ai-agent-graduation-promote-manage_devices:restart_device')).toBeNull();
    expect(screen.getByTestId('ai-agent-graduation-readonly-note')).toBeTruthy();
  });

  it('POSTs the exact promote body and toasts success', async () => {
    mockGraduation(dto());
    render(<AiAgentGraduationPanel {...orgProps} />);
    await clickPromoteAndConfirm('manage_devices:restart_device');

    await waitFor(() => expect(lastMutation().method).toBe('POST'));
    expect(lastMutation().url).toBe('/ai/agents/graduation/promote');
    expect(lastMutation().body).toEqual({
      orgId: 'org-1',
      kind: 'patch',
      opKey: 'manage_devices:restart_device',
    });
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('says the grant applies to future runs only, never to a pending intent', async () => {
    mockGraduation(dto());
    render(<AiAgentGraduationPanel {...orgProps} />);
    fireEvent.click(await screen.findByTestId('ai-agent-graduation-promote-manage_devices:restart_device'));

    const dialogText = (await screen.findByTestId('ai-agent-graduation-promote-confirm'))
      .closest('div[role="dialog"]')?.textContent ?? '';
    expect(dialogText.toLowerCase()).toContain('future runs');
  });

  it('surfaces a 409 with friendly copy and keeps the row', async () => {
    mockGraduation(dto(), () => json({ error: 'policy_decide_disabled' }, false, 409));
    render(<AiAgentGraduationPanel {...orgProps} />);
    await clickPromoteAndConfirm('manage_devices:restart_device');

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    const message = String((showToast.mock.calls.at(-1)?.[0] as { message: string }).message);
    expect(message).not.toBe('policy_decide_disabled');
    expect(message.length).toBeGreaterThan(0);
    expect(screen.getByTestId('ai-agent-graduation-row-manage_devices:restart_device')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// #4187 UI critique — Revoke, the operator-facing mirror of Promote, and the
// demotion cause a `demoted` pill used to leave unexplained.
// ---------------------------------------------------------------------------

const OP = 'manage_devices:restart_device';

async function clickRevokeAndConfirm(opKey: string, reason?: string) {
  fireEvent.click(await screen.findByTestId(`ai-agent-graduation-revoke-${opKey}`));
  if (reason !== undefined) {
    fireEvent.change(await screen.findByTestId('ai-agent-graduation-revoke-reason'), {
      target: { value: reason },
    });
  }
  fireEvent.click(await screen.findByTestId('ai-agent-graduation-revoke-confirm'));
}

describe('AiAgentGraduationPanel — revoke affordance', () => {
  it.each(['tracking', 'eligible', 'demoted'] as const)('hides Revoke on a %s row', async (state) => {
    mockGraduation(dto({ rows: [row({ state })] }));
    render(<AiAgentGraduationPanel {...orgProps} />);

    await screen.findByTestId(`ai-agent-graduation-row-${OP}`);
    expect(screen.queryByTestId(`ai-agent-graduation-revoke-${OP}`)).toBeNull();
  });

  it('offers Revoke on a promoted row even while policy-decide is off', async () => {
    // The route is deliberately not gated on the flag: turning it off must
    // stop new grants without stranding a live one.
    mockGraduation(dto({ rows: [row({ state: 'promoted' })], policyDecideEnabled: false }));
    render(<AiAgentGraduationPanel {...orgProps} />);

    expect(await screen.findByTestId(`ai-agent-graduation-revoke-${OP}`)).toBeTruthy();
  });

  it('POSTs the exact revoke body, including the typed reason and the panel kind', async () => {
    mockGraduation(
      dto({ rows: [row({ state: 'promoted' })] }),
      () => json({ revoked: true, orgAgentId: 'org-agent-9', state: 'demoted' }),
    );
    render(<AiAgentGraduationPanel {...orgProps} />);
    await clickRevokeAndConfirm(OP, 'Customer asked us to stop');

    await waitFor(() => expect(lastMutation().method).toBe('POST'));
    expect(lastMutation().url).toBe('/ai/agents/graduation/revoke');
    expect(lastMutation().body).toEqual({
      orgId: 'org-1',
      opKey: OP,
      // Sent so the route never has to guess between two agents holding the
      // same key — the rows on screen belong to this kind's agent.
      kind: 'patch',
      reason: 'Customer asked us to stop',
    });
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('omits `reason` entirely rather than sending an empty string', async () => {
    // The route records `null` for "the operator supplied none"; '' is not that.
    mockGraduation(
      dto({ rows: [row({ state: 'promoted' })] }),
      () => json({ revoked: true, orgAgentId: 'org-agent-9', state: 'demoted' }),
    );
    render(<AiAgentGraduationPanel {...orgProps} />);
    await clickRevokeAndConfirm(OP, '   ');

    await waitFor(() => expect(lastMutation().method).toBe('POST'));
    expect(lastMutation().body).toEqual({ orgId: 'org-1', opKey: OP, kind: 'patch' });
  });

  it('caps the reason at 500 characters and counts down', async () => {
    mockGraduation(dto({ rows: [row({ state: 'promoted' })] }));
    render(<AiAgentGraduationPanel {...orgProps} />);
    fireEvent.click(await screen.findByTestId(`ai-agent-graduation-revoke-${OP}`));

    const textarea = await screen.findByTestId('ai-agent-graduation-revoke-reason');
    expect(textarea).toHaveAttribute('maxlength', '500');
    fireEvent.change(textarea, { target: { value: 'x'.repeat(40) } });
    expect(screen.getByTestId('ai-agent-graduation-revoke-reason-count').textContent).toContain('460');
  });

  it('re-reads the ledger after a successful revoke rather than guessing the new state', async () => {
    let reads = 0;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method) return Promise.resolve(json({ revoked: true, orgAgentId: 'a', state: 'demoted' }));
      if (typeof url === 'string' && url.startsWith('/ai/agents/graduation')) {
        reads += 1;
        return Promise.resolve(json(dto({
          rows: [row(reads === 1
            ? { state: 'promoted' }
            : { state: 'demoted', demotedAt: '2026-09-02T10:00:00.000Z', demoteReason: 'operator' })],
        })));
      }
      return Promise.resolve(json({ data: [] }));
    });
    render(<AiAgentGraduationPanel {...orgProps} />);
    await clickRevokeAndConfirm(OP);

    await waitFor(() => expect(reads).toBe(2));
    expect(await screen.findByTestId(`ai-agent-graduation-demoted-${OP}`)).toBeTruthy();
  });

  it('maps every revoke refusal token to a sentence and keeps the row', async () => {
    for (const token of ['no_promoted_grant', 'already_demoted', 'already_revoked', 'ambiguous_op_key']) {
      showToast.mockClear();
      mockGraduation(
        dto({ rows: [row({ state: 'promoted' })] }),
        () => json({ error: token }, false, 409),
      );
      const view = render(<AiAgentGraduationPanel {...orgProps} />);
      await clickRevokeAndConfirm(OP);

      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
      const message = String((showToast.mock.calls.at(-1)?.[0] as { message: string }).message);
      expect(message).not.toBe(token);
      expect(message).not.toContain('aiAgentsPage.graduation');
      expect(screen.getByTestId(`ai-agent-graduation-row-${OP}`)).toBeTruthy();
      view.unmount();
    }
  });
});

describe('AiAgentGraduationPanel — demotion cause', () => {
  it('names when and why a demoted grant was taken away', async () => {
    mockGraduation(dto({
      rows: [row({
        state: 'demoted',
        blockedReason: 'has_failures',
        demotedAt: '2026-09-02T10:00:00.000Z',
        demoteReason: 'operator',
      })],
    }));
    render(<AiAgentGraduationPanel {...orgProps} />);

    const cause = await screen.findByTestId(`ai-agent-graduation-demoted-${OP}`);
    const lines = [...cause.querySelectorAll('span')].map((span) => span.textContent ?? '');
    expect(lines).toHaveLength(2);
    // The formatted timestamp, never the raw ISO string.
    expect(lines[0]).not.toContain('2026-09-02T10:00:00.000Z');
    expect(lines[0]).toContain('2026');
    // A sentence, never the bare machine token or a missing catalog entry.
    expect(lines[1]).not.toBe('operator');
    expect(lines[1]).not.toContain('aiAgentsPage.graduation');
    expect(lines[1]?.length).toBeGreaterThan('operator'.length);
  });

  it('gives each demote reason its own distinct sentence, never the raw token', async () => {
    const reasons = ['attempted_failure', 'recurrence', 'operator'] as const;
    const rendered: string[] = [];
    for (const reason of reasons) {
      mockGraduation(dto({ rows: [row({ state: 'demoted', demoteReason: reason })] }));
      const view = render(<AiAgentGraduationPanel {...orgProps} />);

      const text = (await screen.findByTestId(`ai-agent-graduation-demoted-${OP}`)).textContent ?? '';
      // A snake_case token never occurs in prose, so its presence is proof the
      // raw ledger value reached the operator. (`operator` is a real English
      // word and legitimately appears in its own sentence, hence the guard.)
      if (reason.includes('_')) expect(text).not.toContain(reason);
      expect(text).not.toContain('aiAgentsPage.graduation');
      rendered.push(text);
      view.unmount();
    }
    expect(new Set(rendered).size).toBe(reasons.length);
  });

  it('renders nothing extra when the ledger carries neither field', async () => {
    mockGraduation(dto({ rows: [row({ state: 'tracking' })] }));
    render(<AiAgentGraduationPanel {...orgProps} />);

    await screen.findByTestId(`ai-agent-graduation-row-${OP}`);
    expect(screen.queryByTestId(`ai-agent-graduation-demoted-${OP}`)).toBeNull();
  });
});

describe('AiAgentGraduationPanel — partner byOrg fan-out', () => {
  const byOrg: AiAgentGraduationByOrgDto = {
    version: 1,
    promoteThreshold: 20,
    policyDecideEnabled: true,
    byOrgTruncated: true,
    byOrg: [
      {
        orgId: 'org-a',
        orgName: 'Acme',
        agentId: 'agent-a',
        rows: [row({ opKey: 'manage_devices:restart_device' })],
        actOpReliability: [{ opKey: 'devices.restart', executed: 5, verified: 4, failed: 1, recurred: 0 }],
      },
      {
        orgId: 'org-b',
        orgName: 'Belltown',
        agentId: 'agent-b',
        rows: [row({ opKey: 'manage_devices:restart_device', state: 'promoted' })],
        actOpReliability: [],
      },
    ],
  };

  it('reads without an orgId and groups by organization', async () => {
    mockGraduation(byOrg);
    render(<AiAgentGraduationPanel orgId={null} kind="patch" isPartnerScope />);

    await screen.findByTestId('ai-agent-graduation-org-org-a');
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/agents/graduation?kind=patch');
    expect(screen.getByTestId('ai-agent-graduation-org-org-b')).toBeTruthy();
  });

  it('says the org list was truncated', async () => {
    mockGraduation(byOrg);
    render(<AiAgentGraduationPanel orgId={null} kind="patch" isPartnerScope />);
    expect(await screen.findByTestId('ai-agent-graduation-by-org-truncated')).toBeTruthy();
  });

  // The top-level `promoteThreshold` is documented as informational only: it is
  // "the first resolved org's merged value, or the shared default", while each
  // row's state/blockedReason already applied that org's OWN merged threshold.
  // Painting it as every row's denominator produces "22 of 20" beside a
  // `tracking` / `below_threshold` row for an org whose threshold is higher —
  // a self-contradiction on the one surface whose job is to explain why a key
  // is not promotable.
  it('shows the verified count alone in the byOrg view, never a partner-wide denominator', async () => {
    mockGraduation({
      ...byOrg,
      byOrg: [
        {
          ...byOrg.byOrg[0],
          // An org whose own merged threshold is HIGHER than the response's
          // top-level 20: 22 verified, still tracking, still below threshold.
          rows: [row({ state: 'tracking', blockedReason: 'below_threshold' })],
        },
      ],
    });
    render(<AiAgentGraduationPanel orgId={null} kind="patch" isPartnerScope />);

    const tr = await screen.findByTestId('ai-agent-graduation-row-org-a-manage_devices:restart_device');
    const cells = within(tr).getAllByRole('cell').map((cell) => cell.textContent ?? '');
    expect(cells[2].trim()).toBe('22');
    expect(cells[2]).not.toContain('20');
    // Still the row's own field, not a neighbour's.
    expect(cells[3]).toBe('3');
    expect(cells[4]).toBe('7');
  });

  it('explains that the promotion target is resolved per organization', async () => {
    mockGraduation(byOrg);
    render(<AiAgentGraduationPanel orgId={null} kind="patch" isPartnerScope />);
    const note = await screen.findByTestId('ai-agent-graduation-threshold-per-org-note');
    expect((note.textContent ?? '').length).toBeGreaterThan(0);
    expect(note.textContent ?? '').not.toContain('aiAgentsPage.graduation');
  });

  it('promotes with the row group orgId, not the panel prop', async () => {
    mockGraduation(byOrg);
    render(<AiAgentGraduationPanel orgId={null} kind="patch" isPartnerScope />);
    await clickPromoteAndConfirm('org-a-manage_devices:restart_device');

    await waitFor(() => expect(lastMutation().method).toBe('POST'));
    expect(lastMutation().body).toEqual({
      orgId: 'org-a',
      kind: 'patch',
      opKey: 'manage_devices:restart_device',
    });
  });
});

describe('AiAgentGraduationPanel — states with nothing to fetch', () => {
  it('asks an org-scoped caller to choose an organization instead of firing a 400', async () => {
    mockGraduation(dto());
    render(<AiAgentGraduationPanel orgId={null} kind="patch" isPartnerScope={false} />);

    expect(await screen.findByTestId('ai-agent-graduation-org-required')).toBeTruthy();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it('says "no evidence yet" rather than rendering a bare heading', async () => {
    mockGraduation(dto({ rows: [], actOpReliability: [] }));
    render(<AiAgentGraduationPanel {...orgProps} />);
    expect(await screen.findByTestId('ai-agent-graduation-empty')).toBeTruthy();
  });

  it('shows a retryable error when the read fails', async () => {
    mockGraduation(dto());
    fetchWithAuth.mockResolvedValue(json({ error: 'boom' }, false, 500));
    render(<AiAgentGraduationPanel {...orgProps} />);
    expect(await screen.findByTestId('ai-agent-graduation-error')).toBeTruthy();
  });

  // The panel is embedded in the agent policy form, so a body it cannot read
  // must degrade to this panel's own error state — never throw through the
  // render and take the whole form down with it.
  it('reports an unrecognized body as an error instead of crashing the form', async () => {
    mockGraduation({ version: 1, agentId: 'agent-1' });
    render(<AiAgentGraduationPanel {...orgProps} />);

    expect(await screen.findByTestId('ai-agent-graduation-error')).toBeTruthy();
    expect(screen.queryByTestId('ai-agent-graduation-empty')).toBeNull();
  });

  // Live smoke finding: an org override with no partner-wide baseline agent of
  // this kind gets a 404 from GET /ai/agents/graduation — by design,
  // `resolveEffectiveAgentSystem` resolves null and org overrides cannot
  // self-enable (routes/aiAgents.ts). That is not a load FAILURE (retrying
  // can never succeed until a baseline exists), so it must not render the
  // generic error + a Try again button that is dead on arrival.
  it('explains that graduation tracking needs a partner-wide baseline agent on a 404, with no retry button', async () => {
    fetchWithAuth.mockResolvedValue(json({ error: 'agent_not_found' }, false, 404));
    render(<AiAgentGraduationPanel {...orgProps} />);

    expect(await screen.findByTestId('ai-agent-graduation-no-baseline')).toBeTruthy();
    expect(screen.queryByTestId('ai-agent-graduation-error')).toBeNull();
    expect(screen.queryByTestId('ai-agent-graduation-retry')).toBeNull();
  });

  // Every OTHER failure keeps the existing retryable-error path — the 404
  // branch must not swallow a genuine outage.
  it('keeps the retryable error (and retry button) for a non-404 failure', async () => {
    fetchWithAuth.mockResolvedValue(json({ error: 'boom' }, false, 500));
    render(<AiAgentGraduationPanel {...orgProps} />);

    expect(await screen.findByTestId('ai-agent-graduation-error')).toBeTruthy();
    expect(screen.getByTestId('ai-agent-graduation-retry')).toBeTruthy();
    expect(screen.queryByTestId('ai-agent-graduation-no-baseline')).toBeNull();
  });
});

describe('AiAgentForm — partner ceiling hint', () => {
  const agent = (ownerScope: 'partner' | 'organization', mode: AiAgentMode = 'act'): AiAgentDto => ({
    id: 'agent-1',
    kind: 'patch',
    name: 'Patch agent',
    enabled: true,
    mode,
    model: null,
    orgId: ownerScope === 'organization' ? 'org-1' : null,
    partnerId: 'partner-1',
    ownerScope,
    allOrgs: ownerScope === 'partner',
    supportedModes: ['off', 'shadow', 'act'],
    toolAllowlist: [],
    protectedResources: {},
    limits: {},
    triggers: {},
    recipients: {},
    actAssets: {},
    instructions: '',
    cooldownSeconds: 900,
    disabledAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  });

  function renderForm(ownerScope: 'partner' | 'organization', mode: AiAgentMode = 'act') {
    mockGraduation(dto());
    scopeState.orgId = ownerScope === 'organization' ? 'org-1' : null;
    scopeState.isPartnerScope = ownerScope === 'partner';
    render(
      <AiAgentForm
        agent={agent(ownerScope, mode)}
        agents={[]}
        showOwnerScope={ownerScope === 'partner'}
        defaultOwnerScope={ownerScope}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
  }

  it('shows the ceiling hint on the partner form', async () => {
    renderForm('partner');
    expect(await screen.findByTestId('ai-agent-supervised-keys-ceiling-hint')).toBeTruthy();
  });

  it('does not show the ceiling hint on an org form', async () => {
    renderForm('organization');
    await screen.findByTestId('ai-agent-policy-decide');
    expect(screen.queryByTestId('ai-agent-supervised-keys-ceiling-hint')).toBeNull();
  });

  // #4583: partner-level supervisedActionKeys are a CEILING that bounds org
  // grants regardless of the partner row's OWN mode (P2-5, #4533) — a partner
  // admin editing keys on a Shadow-mode baseline still needs the warning that
  // orgs must be granted individually, so the editor (and its hint) must not
  // be hidden behind the partner row's own act-mode gate.
  it('shows the policy-decide editor and ceiling hint on a Shadow-mode partner form', async () => {
    renderForm('partner', 'shadow');
    await screen.findByTestId('ai-agent-policy-decide');
    expect(await screen.findByTestId('ai-agent-supervised-keys-ceiling-hint')).toBeTruthy();
  });

  // An org row's editor still represents live, self-granted authority (not a
  // ceiling), so the "only offered once already in act mode" gate remains for
  // org-owned rows — this stays hidden in Shadow.
  it('still hides the policy-decide editor on a Shadow-mode org form', async () => {
    renderForm('organization', 'shadow');
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(screen.queryByTestId('ai-agent-policy-decide')).toBeNull();
  });
});
