import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W05 (#5220) Task A4 — exact monthly counters, the admission
 * lock and the refusal marker. The DB is mocked at the module boundary for
 * branch logic; the real-row-lock behaviour is flowBudgets.integration.test.ts.
 */

const { executes, calls, ctx } = vi.hoisted(() => ({
  executes: [] as unknown[],
  calls: [] as unknown[],
  ctx: { scope: 'system' as string | undefined },
}));

vi.mock('../../db', () => ({
  db: {
    execute: (q: unknown) => {
      calls.push(q);
      const v = executes.shift();
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? []);
    },
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  getCurrentDbAccessContext: () => (ctx.scope ? { scope: ctx.scope } : undefined),
}));
vi.mock('./notices', () => ({ sendFlowNotice: vi.fn() }));

import { sendFlowNotice } from './notices';
import { chargeFlowRun, lockFlowRunAdmission, readFlowUsage, recordAdmissionRefusal } from './budgets';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const AT = new Date('2027-03-15T12:00:00Z');

/** Concatenated SQL text and the bound values of a drizzle `sql` template. */
function render(q: unknown): { text: string; values: unknown[] } {
  const text: string[] = [];
  const values: unknown[] = [];
  const walk = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (typeof v !== 'object') { values.push(v); return; }
    const name = (v as { constructor?: { name?: string } }).constructor?.name;
    if (name === 'StringChunk') { text.push(((v as { value: string[] }).value).join('')); return; }
    if (name === 'Param') { values.push((v as { value: unknown }).value); return; }
    const chunks = (v as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) { for (const c of chunks) walk(c); return; }
    values.push(v);
  };
  walk(q);
  return { text: text.join('').replace(/\s+/g, ' '), values };
}

beforeEach(() => {
  executes.length = 0;
  calls.length = 0;
  ctx.scope = 'system';
  vi.mocked(sendFlowNotice).mockReset().mockResolvedValue(undefined);
});

describe('lockFlowRunAdmission', () => {
  it('takes a per-owner transaction lock distinct from the slot lock', async () => {
    await lockFlowRunAdmission({ orgId: ORG, partnerId: PARTNER });
    await lockFlowRunAdmission({ orgId: null, partnerId: PARTNER });
    const [a, b] = calls.map(render);
    expect(a!.text).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(a!.values).toContain(`flow_run_admission:org:${ORG}`);
    expect(b!.values).toContain(`flow_run_admission:partner:${PARTNER}`);
  });

  it('outside a system tx throws', async () => {
    ctx.scope = 'organization';
    await expect(lockFlowRunAdmission({ orgId: ORG, partnerId: PARTNER })).rejects.toThrow(/system/);
    expect(calls).toHaveLength(0);
  });
});

describe('chargeFlowRun', () => {
  const base = { flowId: FLOW, owner: { orgId: ORG, partnerId: PARTNER }, flowCap: 10, ownerCap: 100, at: AT };

  it('first run of a month creates both rows', async () => {
    executes.push([{ runs: 1 }], [{ runs: 1 }]);
    await expect(chargeFlowRun(base)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    const [flowRow, ownerRow] = calls.map(render);
    for (const r of [flowRow!, ownerRow!]) {
      expect(r.text).toContain('INSERT INTO flow_usage_counters');
      expect(r.text).toContain('ON CONFLICT (partner_id, org_id, flow_id, period_key) DO UPDATE SET runs = flow_usage_counters.runs + 1');
      expect(r.text).toContain('RETURNING runs');
      expect(r.values).toEqual(expect.arrayContaining([PARTNER, ORG, '2027-03']));
    }
    expect(flowRow!.values).toContain(FLOW);
    expect(ownerRow!.values).not.toContain(FLOW);
  });

  it('a partner-owned flow charges the partner rows (org NULL)', async () => {
    executes.push([{ runs: 1 }], [{ runs: 1 }]);
    await chargeFlowRun({ ...base, owner: { orgId: null, partnerId: PARTNER } });
    for (const r of calls.map(render)) expect(r.values).not.toContain(ORG);
  });

  it('flow cap breach is flow_monthly_cap_reached', async () => {
    executes.push([{ runs: 11 }], [{ runs: 50 }]);
    await expect(chargeFlowRun(base)).resolves.toEqual({ ok: false, error: 'flow_monthly_cap_reached' });
  });

  it('owner cap breach is owner_monthly_cap_reached', async () => {
    executes.push([{ runs: 3 }], [{ runs: 101 }]);
    await expect(chargeFlowRun(base)).resolves.toEqual({ ok: false, error: 'owner_monthly_cap_reached' });
  });

  it('exactly at the cap is admitted', async () => {
    executes.push([{ runs: 10 }], [{ runs: 100 }]);
    await expect(chargeFlowRun(base)).resolves.toEqual({ ok: true });
  });

  it('chargeFlowRun outside a system tx throws', async () => {
    ctx.scope = undefined;
    await expect(chargeFlowRun(base)).rejects.toThrow(/system/);
    ctx.scope = 'partner';
    await expect(chargeFlowRun(base)).rejects.toThrow(/system/);
    expect(calls).toHaveLength(0);
  });
});

describe('readFlowUsage', () => {
  it('returns zero when no row exists yet', async () => {
    executes.push([]);
    await expect(readFlowUsage(FLOW, { orgId: ORG, partnerId: PARTNER }, AT)).resolves.toEqual({ flowRuns: 0, ownerRuns: 0 });
  });

  it('reads the flow row and the owner-total row of the month', async () => {
    executes.push([{ flowRuns: 4, ownerRuns: 9 }]);
    await expect(readFlowUsage(FLOW, { orgId: ORG, partnerId: PARTNER }, AT)).resolves.toEqual({ flowRuns: 4, ownerRuns: 9 });
    expect(render(calls[0]).values).toEqual(expect.arrayContaining([FLOW, PARTNER, ORG, '2027-03']));
  });
});

describe('recordAdmissionRefusal', () => {
  const marked = [{ id: FLOW, name: 'Nightly sync', orgId: ORG, enabledByUserId: USER }];

  it('refusal marker written at most once a minute', async () => {
    executes.push(marked);
    await recordAdmissionRefusal(FLOW, 'flow_queue_full', AT);
    const r = render(calls[0]);
    expect(r.text).toContain('UPDATE flows SET last_admission_refusal_at');
    expect(r.text).toMatch(/last_admission_refusal_at < .* - interval '1 minute'/);
    expect(r.text).toContain('last_admission_refusal_code IS DISTINCT FROM');
    // A second call inside the minute matches no row and does nothing more.
    executes.push([]);
    await recordAdmissionRefusal(FLOW, 'flow_monthly_cap_reached', AT);
    expect(sendFlowNotice).not.toHaveBeenCalled();
  });

  it('cap notice dedupe key is per flow, month and code', async () => {
    executes.push(marked);
    await recordAdmissionRefusal(FLOW, 'owner_monthly_cap_reached', AT);
    expect(sendFlowNotice).toHaveBeenCalledTimes(1);
    const [flow, _doc, notice] = vi.mocked(sendFlowNotice).mock.calls[0]!;
    expect(flow).toMatchObject({ id: FLOW, enabledByUserId: USER, orgId: ORG });
    expect(notice).toMatchObject({ kind: 'cap_reached', dedupeKey: `flow-cap:${FLOW}:2027-03:owner_monthly_cap_reached` });
  });

  it('the active queue refusal marks the banner but sends no notice', async () => {
    executes.push(marked);
    await recordAdmissionRefusal(FLOW, 'flow_queue_full', AT);
    expect(sendFlowNotice).not.toHaveBeenCalled();
  });

  it('a failure is swallowed and logged (best effort after the refusal)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    executes.push(new Error('db down'));
    await expect(recordAdmissionRefusal(FLOW, 'flow_monthly_cap_reached', AT)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
