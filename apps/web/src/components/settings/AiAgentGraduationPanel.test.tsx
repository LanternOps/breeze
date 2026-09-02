import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AiAgentDto,
  AiAgentGraduationByOrgDto,
  AiAgentGraduationDto,
  AiAgentGraduationRowDto,
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
});

describe('AiAgentForm — partner ceiling hint', () => {
  const agent = (ownerScope: 'partner' | 'organization'): AiAgentDto => ({
    id: 'agent-1',
    kind: 'patch',
    name: 'Patch agent',
    enabled: true,
    mode: 'act',
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

  function renderForm(ownerScope: 'partner' | 'organization') {
    mockGraduation(dto());
    scopeState.orgId = ownerScope === 'organization' ? 'org-1' : null;
    scopeState.isPartnerScope = ownerScope === 'partner';
    render(
      <AiAgentForm
        agent={agent(ownerScope)}
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
});
