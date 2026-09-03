import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import AiAgentSchedulesSection, {
  nextCronOccurrence,
  parseFiveFieldCron,
} from './AiAgentSchedulesSection';

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

  // Review fix (#4187 UI critique, P1): the client accepted a cron the server's
  // hourly floor (`isHourlyFloorCron`) refuses — a `*/15` minute field is a
  // structurally valid five-field cron, but a partner with hundreds of orgs
  // fanning that out is exactly the cost the floor exists to prevent.
  it('disables Save and shows the hint when the minute field is not a literal or comma-list (hourly floor)', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));

    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '*/15 * * * *' } });
    expect(screen.getByTestId('ai-agent-schedule-save')).toBeDisabled();
    expect(screen.getByTestId('ai-agent-schedule-cron-invalid')).toBeInTheDocument();

    // A comma-separated list of literal minutes is fine — only the operators
    // that could fire more than hourly are refused.
    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '0,15,30,45 * * * *' } });
    expect(screen.getByTestId('ai-agent-schedule-save')).not.toBeDisabled();
    expect(screen.queryByTestId('ai-agent-schedule-cron-invalid')).toBeNull();
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

  // Review fix (#4187 UI critique, P3): `load`'s dependency array omitted
  // `orgId`, so switching the org switcher while this section stayed mounted
  // never re-fetched — the operator kept looking at the PREVIOUS org's
  // merged overrides until some unrelated prop change (or a remount) forced
  // a reload.
  it('refetches schedules when the selected org changes', async () => {
    mockList([BASELINE]);
    const { rerender } = render(<AiAgentSchedulesSection {...orgProps} />);
    await waitFor(() => expect(screen.getByTestId('ai-agent-schedule-s-1')).toBeInTheDocument());

    const getsBefore = fetchWithAuth.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.startsWith('/ai/agents/schedules?'),
    ).length;
    expect(getsBefore).toBeGreaterThan(0);

    rerender(<AiAgentSchedulesSection {...orgProps} orgId="org-2" />);

    await waitFor(() => {
      const getsAfter = fetchWithAuth.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.startsWith('/ai/agents/schedules?'),
      ).length;
      expect(getsAfter).toBeGreaterThan(getsBefore);
    });
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

// ---------------------------------------------------------------------------
// #4187 UI critique — the next-run preview. Structural cron validity is the
// only feedback a five-field expression used to give, so a typo'd day-of-week
// read as a working schedule until it failed to fire.
// ---------------------------------------------------------------------------

describe('nextCronOccurrence / parseFiveFieldCron', () => {
  // Every case is asserted on WALL-CLOCK parts read as UTC — that is exactly
  // what the function returns (see its module comment).
  const at = (iso: string) => Date.parse(iso);
  const next = (cron: string, fromIso: string) => {
    const fields = parseFiveFieldCron(cron);
    expect(fields).not.toBeNull();
    return nextCronOccurrence(fields!, at(fromIso))?.toISOString() ?? null;
  };

  it.each([
    // daily at 03:00, before and after today's occurrence
    ['0 3 * * *', '2026-09-02T01:10:00Z', '2026-09-02T03:00:00.000Z'],
    ['0 3 * * *', '2026-09-02T03:00:00Z', '2026-09-03T03:00:00.000Z'],
    // step, list and range forms
    ['*/15 * * * *', '2026-09-02T01:07:00Z', '2026-09-02T01:15:00.000Z'],
    ['0 6,18 * * *', '2026-09-02T07:00:00Z', '2026-09-02T18:00:00.000Z'],
    ['0 6 * * 1-5', '2026-09-05T00:00:00Z', '2026-09-07T06:00:00.000Z'],
    // 2026-09-02 is a Wednesday; Monday is the 7th.
    ['0 7 * * 1', '2026-09-02T09:00:00Z', '2026-09-07T07:00:00.000Z'],
    // day-of-week names, and 7 as a second spelling of Sunday
    ['0 7 * * mon', '2026-09-02T09:00:00Z', '2026-09-07T07:00:00.000Z'],
    ['0 7 * * 7', '2026-09-02T09:00:00Z', '2026-09-06T07:00:00.000Z'],
    // month rollover, and a month name
    ['0 0 1 * *', '2026-09-20T00:00:00Z', '2026-10-01T00:00:00.000Z'],
    ['0 0 1 jan *', '2026-09-20T00:00:00Z', '2027-01-01T00:00:00.000Z'],
    // Vixie rule: with BOTH day fields restricted, EITHER may match. The 4th
    // is a Friday, so a Monday-or-the-4th cron fires on the 4th first.
    ['0 5 4 * 1', '2026-09-02T00:00:00Z', '2026-09-04T05:00:00.000Z'],
  ])('resolves %s from %s', (cron, from, expected) => {
    expect(next(cron, from)).toBe(expected);
  });

  it('returns null for a structurally valid cron that can never fire', () => {
    // 30 February. `isStructurallyValidCron` accepts it (both fields are in
    // range) — only evaluation can tell the operator it will never run.
    expect(next('0 0 30 2 *', '2026-09-02T00:00:00Z')).toBeNull();
  });

  it.each([
    '', 'every morning', '0 6 * *', '0 6 * * * *', '60 6 * * *', '0 6 * * 8', '0 6 * * 5-1', '0 6 * * ',
  ])('refuses to parse %s', (cron) => {
    expect(parseFiveFieldCron(cron)).toBeNull();
  });
});

describe('AiAgentSchedulesSection next-run preview', () => {
  it('shows a next run beside the stored cron', async () => {
    mockList([BASELINE]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    const line = await screen.findByTestId('ai-agent-schedule-next-run-s-1');
    // The schedule's own zone is named, never the viewer's.
    expect(line.textContent).toContain('America/New_York');
    expect(line.textContent).toMatch(/\d/);
  });

  // Review fix (#4187 UI critique, P3): the preview used to render alongside
  // the "Enter a valid five-field cron expression" banner, showing "Invalid
  // schedule" twice for the same problem. Now the preview is withheld
  // entirely while `cronValid` is false — the cron-invalid banner alone says
  // the expression is bad, so the preview's OWN "invalid" variant is only
  // reachable for a cron the hourly-floor/weekly-literal rules accept but
  // that still fails cron-conditions.ts's stricter five-field evaluator.
  it('hides the next-run preview once the cron fails validation, leaving only the cron-invalid message', async () => {
    mockList([BASELINE]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    expect(await screen.findByTestId('ai-agent-schedule-editor-next-run')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: 'every morning' } });

    expect(await screen.findByTestId('ai-agent-schedule-cron-invalid')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-agent-schedule-editor-next-run')).toBeNull();
    expect(screen.queryByTestId('ai-agent-schedule-editor-next-run-invalid')).toBeNull();
    expect(screen.queryByTestId('ai-agent-schedule-editor-next-run-none')).toBeNull();

    // Recovers once the expression is valid again.
    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '0 3 * * *' } });
    expect(await screen.findByTestId('ai-agent-schedule-editor-next-run')).toBeInTheDocument();
  });

  it('updates the preview live as a valid expression is edited', async () => {
    mockList([BASELINE]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    const before = (await screen.findByTestId('ai-agent-schedule-editor-next-run')).textContent;

    fireEvent.change(screen.getByTestId('ai-agent-schedule-cron'), { target: { value: '17 4 * * *' } });

    expect(screen.getByTestId('ai-agent-schedule-editor-next-run').textContent).not.toBe(before);
  });

  it('says so when a valid expression has no occurrence in the next year', async () => {
    mockList([BASELINE]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    fireEvent.change(await screen.findByTestId('ai-agent-schedule-cron'), { target: { value: '0 0 30 2 *' } });

    expect(await screen.findByTestId('ai-agent-schedule-editor-next-run-none')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// onDirtyChange — what the parent form blocks its Save and its drawer on.
// Review finding 3: dirtiness was `draft !== null`, so OPENING an editor to
// read a schedule counted as unsaved work.
// ---------------------------------------------------------------------------
describe('AiAgentSchedulesSection unsaved-work reporting (#4187 UI critique round 2)', () => {
  it('does not report an opened-but-unedited draft as dirty', async () => {
    mockList([BASELINE]);
    const onDirtyChange = vi.fn();
    render(<AiAgentSchedulesSection {...partnerProps} onDirtyChange={onDirtyChange} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    await screen.findByTestId('ai-agent-schedule-editor');

    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('reports dirty on the first field change, for every editable field', async () => {
    mockList([BASELINE]);
    const onDirtyChange = vi.fn();
    render(<AiAgentSchedulesSection {...partnerProps} onDirtyChange={onDirtyChange} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    fireEvent.change(await screen.findByTestId('ai-agent-schedule-cron'), { target: { value: '0 4 * * *' } });
    expect(onDirtyChange).toHaveBeenCalledWith(true);

    // The enabled toggle and the kind checkboxes are edits too — a guard that
    // only watched the cron box would discard either without a word.
    onDirtyChange.mockClear();
    fireEvent.click(screen.getByTestId('ai-agent-schedule-cancel'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByTestId('ai-agent-schedule-edit-s-1'));
    fireEvent.click(await screen.findByTestId('ai-agent-schedule-enabled'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    onDirtyChange.mockClear();
    fireEvent.click(screen.getByTestId('ai-agent-schedule-cancel'));
    fireEvent.click(screen.getByTestId('ai-agent-schedule-edit-s-1'));
    fireEvent.click(await screen.findByTestId('ai-agent-schedule-kind-disk_pressure'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('clears dirty when the draft is cancelled and when it saves', async () => {
    mockList([BASELINE]);
    const onDirtyChange = vi.fn();
    render(<AiAgentSchedulesSection {...partnerProps} onDirtyChange={onDirtyChange} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    fireEvent.change(await screen.findByTestId('ai-agent-schedule-cron'), { target: { value: '0 4 * * *' } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByTestId('ai-agent-schedule-save'));
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false));
  });

  // Re-opening a draft after an edit must start clean: `touched` is per-draft,
  // not per-mount, or the section would stay latched dirty forever after one
  // keystroke anywhere.
  it('starts clean again when a second draft is opened', async () => {
    mockList([BASELINE]);
    const onDirtyChange = vi.fn();
    render(<AiAgentSchedulesSection {...partnerProps} onDirtyChange={onDirtyChange} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-edit-s-1'));
    fireEvent.change(await screen.findByTestId('ai-agent-schedule-cron'), { target: { value: '0 4 * * *' } });
    fireEvent.click(screen.getByTestId('ai-agent-schedule-cancel'));

    onDirtyChange.mockClear();
    fireEvent.click(screen.getByTestId('ai-agent-schedule-edit-s-1'));
    await screen.findByTestId('ai-agent-schedule-editor');
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });
});

// ---------------------------------------------------------------------------
// #4187 UI critique 3 — empty-state/editor overlap, the enabled switch row,
// grouped/searchable timezone select, and the shared badge idiom on the
// "All orgs" chip.
// ---------------------------------------------------------------------------

describe('AiAgentSchedulesSection empty state vs. open create editor (#4187 UI critique 3)', () => {
  it('does not render "No sweep schedules yet" above an already-open create editor', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    await waitFor(() => expect(screen.getByTestId('ai-agent-schedule-add')).toBeInTheDocument());
    // Before opening a draft, the empty state is the only thing there is to say.
    expect(screen.getByTestId('ai-agent-schedules-empty')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ai-agent-schedule-add'));

    expect(await screen.findByTestId('ai-agent-schedule-editor')).toBeInTheDocument();
    // The empty state used to gate on `schedules.length === 0` alone, so it
    // kept rendering directly above the create form it was telling the
    // operator to use.
    expect(screen.queryByTestId('ai-agent-schedules-empty')).toBeNull();
  });

  it('shows the empty state again once the open create draft is cancelled', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
    await screen.findByTestId('ai-agent-schedule-editor');
    fireEvent.click(screen.getByTestId('ai-agent-schedule-cancel'));

    expect(await screen.findByTestId('ai-agent-schedules-empty')).toBeInTheDocument();
  });
});

describe('AiAgentSchedulesSection enabled switch row (#4187 UI critique 3)', () => {
  it('renders the enabled control as a labelled switch, not an unlabelled seventh checkbox', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
    const toggle = await screen.findByTestId('ai-agent-schedule-enabled');

    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle).toHaveAttribute('role', 'switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // Named via its own visible label, not left to context the way it sat
    // among six identically-shaped "Checks to run" checkboxes before.
    expect(toggle).toHaveAttribute('aria-labelledby');
    const labelId = toggle.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)?.textContent).toBe('Enabled');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });
});

describe('AiAgentSchedulesSection timezone picker (#4187 UI critique 3)', () => {
  it('sets the viewer\'s own IANA zone when "Use my timezone" is clicked', async () => {
    const originalResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = () =>
      ({ ...originalResolvedOptions.call(new Intl.DateTimeFormat()), timeZone: 'Asia/Tokyo' });
    try {
      mockList([]);
      render(<AiAgentSchedulesSection {...partnerProps} />);

      fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
      fireEvent.change(await screen.findByTestId('ai-agent-schedule-timezone'), {
        target: { value: 'Europe/Paris' },
      });
      expect(screen.getByTestId('ai-agent-schedule-timezone')).toHaveValue('Europe/Paris');

      fireEvent.click(screen.getByTestId('ai-agent-schedule-use-my-timezone'));
      expect(screen.getByTestId('ai-agent-schedule-timezone')).toHaveValue('Asia/Tokyo');
    } finally {
      Intl.DateTimeFormat.prototype.resolvedOptions = originalResolvedOptions;
    }
  });

  it('groups the timezone options into <optgroup>s by region', async () => {
    mockList([]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    fireEvent.click(await screen.findByTestId('ai-agent-schedule-add'));
    const select = await screen.findByTestId('ai-agent-schedule-timezone');

    const groups = select.querySelectorAll('optgroup');
    // A flat 400+ option list, grouped by continent, is necessarily more than
    // one group — and every option lives inside SOME group, not loose beside them.
    expect(groups.length).toBeGreaterThan(1);
    expect(select.querySelectorAll(':scope > option').length).toBe(0);
    expect([...groups].some((group) => group.getAttribute('label') === 'America')).toBe(true);
  });
});

describe('AiAgentSchedulesSection "All orgs" chip (#4187 UI critique 3)', () => {
  it('renders the schedule row\'s "All orgs" chip through the shared badge idiom', async () => {
    mockList([BASELINE]);
    render(<AiAgentSchedulesSection {...partnerProps} />);

    const row = await screen.findByTestId('ai-agent-schedule-s-1');
    const chip = within(row).getByText('All orgs');
    // Not the old bespoke `bg-primary/10 text-primary` pill — the same
    // dark-mode-aware pill idiom as the kind badge beside it.
    expect(chip.className).toContain('rounded-full');
    expect(chip.className).toMatch(/dark:/);
    expect(chip.className).not.toContain('bg-primary/10');
  });
});
