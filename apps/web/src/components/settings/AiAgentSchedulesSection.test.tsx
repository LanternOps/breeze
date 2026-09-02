import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentEffectiveScheduleDto } from '@breeze/shared';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
// Resolved relative to THIS file (components/settings/), the same module
// runAction.ts reaches via '../components/shared/Toast' — vitest matches on
// the resolved path, so this also intercepts runAction's own import
// (established pattern: AlertVerdictBadge.test.tsx).
vi.mock('../shared/Toast', () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import AiAgentSchedulesSection from './AiAgentSchedulesSection';

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const BASELINE: AiAgentEffectiveScheduleDto = {
  id: 's-1',
  ownerScope: 'partner',
  orgId: null,
  partnerId: 'p-1',
  agentId: 'a-1',
  baselineScheduleId: null,
  // P2-3: every schedule row now declares which run profile its occurrence
  // produces. `sweep` is what every pre-P2-3 row means.
  kind: 'sweep',
  cron: '0 3 * * *',
  timezone: 'America/New_York',
  sweepKinds: ['disk_pressure', 'stale_agents'],
  enabled: true,
  lastEnqueuedAt: '2026-08-28T03:00:00.000Z',
  lastOccurrenceKey: 'occ-1',
  lastRunSummary: {
    occurrenceKey: 'occ-1',
    orgsTotal: 12,
    runsAdmitted: 10,
    runsSkipped: 2,
    skipReasons: { circuit_open: 2 },
    enqueuedAt: '2026-08-28T03:00:00.000Z',
  },
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  effective: { enabled: true, sweepKinds: ['disk_pressure', 'stale_agents'] },
  override: null,
};

function mockList(schedules: AiAgentEffectiveScheduleDto[], write?: (url: string, init: RequestInit) => Response) {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      return Promise.resolve(write ? write(url, init) : json({ data: schedules[0] }, true, 201));
    }
    return Promise.resolve(json({ data: schedules }));
  });
}

const mutations = () =>
  fetchWithAuth.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method);

function lastMutation() {
  const call = mutations().at(-1);
  const init = call?.[1] as RequestInit | undefined;
  return {
    url: call?.[0] as string | undefined,
    method: init?.method,
    body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
  };
}

const partnerProps = {
  agentId: 'a-1',
  agentOwnerScope: 'partner' as const,
  isPartnerScope: true,
  orgId: null,
};

const orgProps = {
  agentId: 'a-1',
  agentOwnerScope: 'partner' as const,
  isPartnerScope: false,
  orgId: 'org-1',
};

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('AiAgentSchedulesSection', () => {
  it('renders the partner baselines from the API with their kinds and last-run counters', async () => {
    mockList([BASELINE]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-schedule-s-1')).toBeInTheDocument());
    const row = screen.getByTestId('ai-agent-schedule-s-1');
    expect(row.textContent).toContain('0 3 * * *');
    expect(row.textContent).toContain('America/New_York');
    // Kind labels are translated, never the raw enum token.
    expect(row.textContent).toContain('Disk pressure');
    expect(row.textContent).toContain('Stale agents');
    expect(row.textContent).not.toContain('disk_pressure');
    // lastRunSummary counters.
    expect(screen.getByTestId('ai-agent-schedule-lastrun-s-1').textContent).toContain('10');
    expect(screen.getByTestId('ai-agent-schedule-lastrun-s-1').textContent).toContain('12');
    expect(screen.getByTestId('ai-agent-schedule-lastrun-s-1').textContent).toContain('2');
    // GET only — rendering must never mutate.
    expect(mutations()).toHaveLength(0);
  });

  it('posts a partner baseline create with the exact wire shape', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));

    fireEvent.change(await screen.findByTestId('ai-agent-schedule-cron'), {
      target: { value: '0 4 * * 1' },
    });
    fireEvent.change(screen.getByTestId('ai-agent-schedule-timezone'), {
      target: { value: 'Europe/Paris' },
    });
    // Start from every kind selected; untick all but two so the asserted body
    // is a real selection rather than the default.
    fireEvent.click(screen.getByTestId('ai-agent-schedule-kind-pending_reboots'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-kind-failed_backups'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-kind-service_down'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-kind-unpatched_critical'));

    fireEvent.click(screen.getByTestId('ai-agent-schedule-save'));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    const { url, method, body } = lastMutation();
    expect(url).toBe('/ai/agents/schedules');
    expect(method).toBe('POST');
    expect(body).toEqual({
      ownerScope: 'partner',
      agentId: 'a-1',
      cron: '0 4 * * 1',
      timezone: 'Europe/Paris',
      sweepKinds: ['disk_pressure', 'stale_agents'],
      enabled: true,
    });
  });

  it('disables Save and shows the hint while the cron is not a five-field expression', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));

    // `*/5` is the realistic operator mistake: it looks like a cron and is not.
    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '*/5' } });
    expect(screen.getByTestId('ai-agent-schedule-save')).toBeDisabled();
    expect(screen.getByTestId('ai-agent-schedule-cron-invalid')).toBeInTheDocument();

    // A SIX-field pattern is structurally valid for BullMQ but the sweeper's
    // occurrence evaluator is strictly five-field, so it must be refused too.
    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '0 0 4 * * 1' } });
    expect(screen.getByTestId('ai-agent-schedule-save')).toBeDisabled();

    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '15 2 * * *' } });
    expect(screen.getByTestId('ai-agent-schedule-save')).not.toBeDisabled();
    expect(screen.queryByTestId('ai-agent-schedule-cron-invalid')).toBeNull();

    fireEvent.click(screen.getByTestId('ai-agent-schedule-save'));
    await waitFor(() => expect(mutations()).toHaveLength(1));
  });

  it('patches an existing baseline instead of creating a second one', async () => {
    mockList([BASELINE], () => json({ data: BASELINE }));
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    expect(screen.getByTestId('ai-agent-schedule-cron')).toHaveValue('0 3 * * *');

    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '30 5 * * *' } });
    fireEvent.click(screen.getByTestId('ai-agent-schedule-enabled'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-save'));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    const { url, method, body } = lastMutation();
    expect(url).toBe('/ai/agents/schedules/s-1');
    expect(method).toBe('PATCH');
    expect(body).toEqual({
      cron: '30 5 * * *',
      timezone: 'America/New_York',
      sweepKinds: ['disk_pressure', 'stale_agents'],
      enabled: false,
    });
  });

  it('deletes through runAction behind an inline two-step confirm, never a native dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockList([BASELINE], () => json(null, true, 204));
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-delete'));
    // First click arms the confirm; it must NOT have fired the DELETE yet.
    expect(mutations()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('ai-agent-schedule-delete'));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    const { url, method } = lastMutation();
    expect(url).toBe('/ai/agents/schedules/s-1');
    expect(method).toBe('DELETE');
    // runAction reports the outcome — a silent delete is the failure mode the
    // no-silent-mutations contract exists to prevent.
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('shows an org session the baseline read-only and offers only the override control', async () => {
    mockList([BASELINE]);
    render(<AiAgentSchedulesSection {...orgProps} />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-schedule-s-1')).toBeInTheDocument());
    expect(screen.queryByTestId('ai-agent-schedule-add')).toBeNull();
    expect(screen.queryByTestId('ai-agent-schedule-edit-s-1')).toBeNull();
    expect(screen.queryByTestId('ai-agent-schedule-delete')).toBeNull();
    expect(screen.getByTestId('ai-agent-schedule-override-s-1')).toBeInTheDocument();
  });

  it('creates an org override with the tighten-only wire shape and offers no kind the baseline lacks', async () => {
    mockList([BASELINE], () => json({ data: { ...BASELINE, id: 'o-1' } }, true, 201));
    render(<AiAgentSchedulesSection {...orgProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-override-s-1'));

    // Tighten-only: the override editor may only offer the baseline's kinds.
    expect(screen.getByTestId('ai-agent-schedule-kind-disk_pressure')).toBeInTheDocument();
    expect(screen.getByTestId('ai-agent-schedule-kind-stale_agents')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-schedule-kind-service_down')).toBeNull();
    expect(screen.queryByTestId('ai-agent-schedule-kind-pending_reboots')).toBeNull();
    // An override never carries its own cadence — it runs on the baseline's.
    expect(screen.queryByTestId('ai-agent-schedule-cron')).toBeNull();
    expect(screen.queryByTestId('ai-agent-schedule-timezone')).toBeNull();

    fireEvent.click(screen.getByTestId('ai-agent-schedule-kind-stale_agents'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-save'));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    const { url, method, body } = lastMutation();
    expect(url).toBe('/ai/agents/schedules');
    expect(method).toBe('POST');
    expect(body).toEqual({
      ownerScope: 'organization',
      orgId: 'org-1',
      baselineScheduleId: 's-1',
      enabled: true,
      sweepKinds: ['disk_pressure'],
    });
  });

  it('patches an existing override rather than posting a duplicate', async () => {
    const withOverride: AiAgentEffectiveScheduleDto = {
      ...BASELINE,
      effective: { enabled: true, sweepKinds: ['disk_pressure'] },
      override: { id: 'o-1', enabled: true, sweepKinds: ['disk_pressure'] },
    };
    mockList([withOverride], () => json({ data: withOverride }));
    render(<AiAgentSchedulesSection {...orgProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-override-s-1'));
    // Seeded from the stored override, not from the baseline.
    expect(screen.getByTestId('ai-agent-schedule-kind-disk_pressure')).toBeChecked();
    expect(screen.getByTestId('ai-agent-schedule-kind-stale_agents')).not.toBeChecked();

    fireEvent.click(screen.getByTestId('ai-agent-schedule-enabled'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-save'));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    const { url, method, body } = lastMutation();
    expect(url).toBe('/ai/agents/schedules/o-1');
    expect(method).toBe('PATCH');
    // Never cron/timezone/ownerScope/baselineScheduleId — the API rejects them.
    expect(body).toEqual({ enabled: false, sweepKinds: ['disk_pressure'] });
  });

  it('translates the server 422 code instead of toasting the raw machine token', async () => {
    mockList([BASELINE], () =>
      json({ error: 'kinds_not_subset', message: 'An org override may only tighten the baseline' }, false, 422),
    );
    render(<AiAgentSchedulesSection {...orgProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-override-s-1'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-save'));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const toasted = showToast.mock.calls.map(([arg]) => (arg as { message: string }).message).join('\n');
    expect(toasted).not.toContain('kinds_not_subset');
    expect(toasted).toContain('narrow the baseline');
  });

  it('says schedules could not be loaded rather than rendering an empty list', async () => {
    fetchWithAuth.mockResolvedValue(json({ error: 'nope' }, false, 500));
    render(<AiAgentSchedulesSection {...partnerProps} />);

    expect(await screen.findByTestId('ai-agent-schedules-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-schedules-empty')).toBeNull();
  });

  it('treats a wrong-SHAPED 200 body as a load failure instead of throwing in render', async () => {
    // Array-shaped but not schedule-shaped: exactly what a caller whose route
    // matcher swallowed '/ai/agents/schedules' answers with (the AGENTS list).
    // Before the row guard, the first `sweepKinds.map` threw inside render and
    // took the whole agent form down with it.
    fetchWithAuth.mockResolvedValue(json({ data: [{ id: 'a1', kind: 'triage', name: 'Triage' }] }));
    render(<AiAgentSchedulesSection {...partnerProps} />);

    expect(await screen.findByTestId('ai-agent-schedules-failed')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-schedules-list')).toBeNull();
  });

  // ── Phase 2 wave P2-3 (#4190) — the narrative schedule kind ────────────
  //
  // A narrative baseline produces the weekly org report rather than sweep
  // findings, and the two kinds carry incompatible server rules: narrative
  // must fire on a WEEKLY LITERAL cron and evaluates NO sweep kinds, where a
  // sweep may fire hourly and must select at least one. The editor has to
  // make the wrong body unauthorable, not merely rejected.

  const NARRATIVE_BASELINE: AiAgentEffectiveScheduleDto = {
    ...BASELINE,
    id: 'n-1',
    kind: 'narrative',
    cron: '0 7 * * 1',
    sweepKinds: [],
    effective: { enabled: true, sweepKinds: [] },
  };

  it('offers the schedule kind on create only, never on an edit', async () => {
    mockList([BASELINE]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    // Editing a saved baseline: `kind` is immutable (the update schema is
    // .strict() and admits none), so the control must not be offered.
    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    expect(screen.queryByTestId('ai-agent-schedule-kind')).toBeNull();

    fireEvent.click(screen.getByTestId('ai-agent-schedule-cancel'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-add'));
    expect(screen.getByTestId('ai-agent-schedule-kind')).toHaveValue('sweep');
  });

  it('switches the create form to a weekly-literal cron with no checks when narrative is chosen', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
    // Sweep default: nightly cron, every check offered.
    expect(screen.getByTestId('ai-agent-schedule-cron')).toHaveValue('0 3 * * *');
    expect(screen.getByTestId('ai-agent-schedule-kinds')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('ai-agent-schedule-kind'), { target: { value: 'narrative' } });

    expect(screen.getByTestId('ai-agent-schedule-cron')).toHaveValue('0 7 * * 1');
    // A narrative schedule evaluates no sweep kinds — the whole block goes.
    expect(screen.queryByTestId('ai-agent-schedule-kinds')).toBeNull();
    expect(screen.queryByTestId('ai-agent-schedule-kind-disk_pressure')).toBeNull();
    // Weekly-only cadence hint replaces the five-field sweep hint.
    expect(screen.getByTestId('ai-agent-schedule-weekly-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-schedule-cron-hint')).toBeNull();
    // Save is live: the default cron is already a valid weekly literal, and
    // "no kinds" is the narrative branch's correct state, not an error.
    expect(screen.getByTestId('ai-agent-schedule-save')).not.toBeDisabled();
  });

  it('refuses a narrative cron that fires more than once a week', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
    fireEvent.change(screen.getByTestId('ai-agent-schedule-kind'), { target: { value: 'narrative' } });

    // Structurally valid, inside the hourly floor, and DAILY — the exact
    // body the server answers with `invalid_cron_for_kind`.
    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '0 7 * * *' } });
    expect(screen.getByTestId('ai-agent-schedule-save')).toBeDisabled();
    expect(screen.getByTestId('ai-agent-schedule-cron-invalid')).toBeInTheDocument();

    // A weekday list fires twice a week — also refused.
    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '0 7 * * 1,3' } });
    expect(screen.getByTestId('ai-agent-schedule-save')).toBeDisabled();

    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '30 6 * * 5' } });
    expect(screen.getByTestId('ai-agent-schedule-save')).not.toBeDisabled();
  });

  it('posts a narrative baseline carrying kind and NO sweepKinds', async () => {
    mockList([], () => json({ data: NARRATIVE_BASELINE }, true, 201));
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
    fireEvent.change(screen.getByTestId('ai-agent-schedule-kind'), { target: { value: 'narrative' } });
    fireEvent.change(screen.getByTestId('ai-agent-schedule-timezone'), {
      target: { value: 'Europe/Paris' },
    });
    fireEvent.click(screen.getByTestId('ai-agent-schedule-save'));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    const { url, method, body } = lastMutation();
    expect(url).toBe('/ai/agents/schedules');
    expect(method).toBe('POST');
    expect(body).toEqual({
      ownerScope: 'partner',
      kind: 'narrative',
      agentId: 'a-1',
      cron: '0 7 * * 1',
      timezone: 'Europe/Paris',
      enabled: true,
    });
    // Not merely empty — absent. `[]` would parse, but the key has no meaning
    // on this branch and shipping it invites a future reader to populate it.
    expect(body).not.toHaveProperty('sweepKinds');
  });

  it('badges each schedule row with the kind its occurrences produce', async () => {
    mockList([BASELINE, NARRATIVE_BASELINE]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-schedule-n-1')).toBeInTheDocument());
    expect(screen.getByTestId('ai-agent-schedule-kind-badge-s-1')).toHaveTextContent('Sweep');
    expect(screen.getByTestId('ai-agent-schedule-kind-badge-n-1')).toHaveTextContent('Weekly report');
    // A narrative row names no checks — "No checks" would read as a
    // misconfiguration rather than as the kind's defining property.
    expect(screen.getByTestId('ai-agent-schedule-n-1').textContent).not.toContain('No checks');
  });

  it('offers an org override of a narrative baseline only the enabled toggle', async () => {
    mockList([NARRATIVE_BASELINE], () => json({ data: { ...NARRATIVE_BASELINE, id: 'o-2' } }, true, 201));
    render(<AiAgentSchedulesSection {...orgProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-override-n-1'));

    // No kinds (the baseline evaluates none and an override inherits its
    // kind), no cadence (an override never carries one).
    expect(screen.queryByTestId('ai-agent-schedule-kinds')).toBeNull();
    expect(screen.queryByTestId('ai-agent-schedule-cron')).toBeNull();
    expect(screen.queryByTestId('ai-agent-schedule-timezone')).toBeNull();
    expect(screen.getByTestId('ai-agent-schedule-enabled')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-agent-schedule-enabled'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-save'));

    await waitFor(() => expect(mutations()).toHaveLength(1));
    const { url, method, body } = lastMutation();
    expect(url).toBe('/ai/agents/schedules');
    expect(method).toBe('POST');
    // `sweepKinds` is REQUIRED on the org-override create branch, and `[]` is
    // the only value a narrative baseline admits.
    expect(body).toEqual({
      ownerScope: 'organization',
      orgId: 'org-1',
      baselineScheduleId: 'n-1',
      enabled: false,
      sweepKinds: [],
    });
  });

  it('does not fetch or offer schedules for an org-owned agent', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} agentOwnerScope="organization" />);

    expect(await screen.findByTestId('ai-agent-schedules-partner-only')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-schedule-add')).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
