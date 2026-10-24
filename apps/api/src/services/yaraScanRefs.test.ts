import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  device: null as Record<string, unknown> | null,
  sets: [] as Array<Record<string, unknown>>,
  setQueries: 0,
}));

vi.mock('../db', async () => {
  const schema = await import('../db/schema');
  const select = () => ({
    from: (table: unknown) => {
      if (table === schema.devices) {
        return {
          innerJoin: () => ({ where: () => ({ limit: () => Promise.resolve(state.device ? [state.device] : []) }) }),
        };
      }
      return {
        where: () => {
          state.setQueries++;
          return Promise.resolve(state.sets);
        },
      };
    },
  });
  return { db: { select } };
});

import { YARA_BUILTIN_RULE_SET_ID } from '@breeze/shared';
import {
  agentSupportsYaraScan,
  MIN_AGENT_VERSION_YARA_SCAN,
  planYaraScan,
  resolveYaraRuleSetRefs,
} from './yaraScanRefs';

const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const C = 'cccccccc-0000-4000-8000-00000000000c';
const D = 'dddddddd-0000-4000-8000-00000000000d';
const SHA = 'f'.repeat(64);
const pub = (id: string, version: number, extra: Record<string, unknown> = {}) => ({
  id, enabled: true, publishedVersion: version, publishedSha256: SHA, ...extra,
});

beforeEach(() => {
  state.device = { id: 'dev-1', agentId: 'agent-1', orgId: 'org-1', partnerId: 'p-1' };
  state.sets = [];
  state.setQueries = 0;
});

describe('agentSupportsYaraScan', () => {
  it.each([
    [MIN_AGENT_VERSION_YARA_SCAN, true],
    ['999.0.0', true],
    [`${MIN_AGENT_VERSION_YARA_SCAN}-rc1`, true], // core-semver compare, like systemCleanup
    ['0.1.0', false],
    ['', false],
    ['dev', false],
    [null, false],
    [undefined, false],
  ])('%s -> %s', (v, expected) => {
    expect(agentSupportsYaraScan(v as string | null | undefined)).toBe(expected);
  });
});

describe('resolveYaraRuleSetRefs', () => {
  it('keeps ruleSetIds order and builds agent-relative urls at the published version', async () => {
    state.sets = [pub(B, 2), pub(A, 7)];
    const res = await resolveYaraRuleSetRefs({ deviceId: 'dev-1', ruleSetIds: [A, B] });
    expect(res.errors).toEqual([]);
    expect(res.refs).toEqual([
      { id: A, version: 7, sha256: SHA, url: `/api/v1/agents/agent-1/yara/rule-sets/${A}/7` },
      { id: B, version: 2, sha256: SHA, url: `/api/v1/agents/agent-1/yara/rule-sets/${B}/2` },
    ]);
  });

  it('reports missing, disabled and never-published sets instead of sending them', async () => {
    state.sets = [pub(A, 1), pub(B, 3, { enabled: false }), pub(C, 0, { publishedSha256: null })];
    const res = await resolveYaraRuleSetRefs({ deviceId: 'dev-1', ruleSetIds: [A, B, C, D] });
    expect(res.refs.map((r) => r.id)).toEqual([A]);
    expect(res.errors).toEqual([
      { id: B, code: 'disabled' },
      { id: C, code: 'not_published' },
      { id: D, code: 'not_found' },
    ]);
  });

  it('includes the built-in pack when the policy lists it', async () => {
    state.sets = [pub(YARA_BUILTIN_RULE_SET_ID, 12)];
    const res = await resolveYaraRuleSetRefs({ deviceId: 'dev-1', ruleSetIds: [YARA_BUILTIN_RULE_SET_ID] });
    expect(res.refs).toHaveLength(1);
    expect(res.refs[0]!.version).toBe(12);
  });

  it('no ids -> no query', async () => {
    const res = await resolveYaraRuleSetRefs({ deviceId: 'dev-1', ruleSetIds: [] });
    expect(res).toEqual({ refs: [], errors: [] });
    expect(state.setQueries).toBe(0);
  });

  it('an unknown device resolves nothing and reports every id as not_found', async () => {
    state.device = null;
    const res = await resolveYaraRuleSetRefs({ deviceId: 'dev-x', ruleSetIds: [A] });
    expect(res).toEqual({ refs: [], errors: [{ id: A, code: 'not_found' }] });
  });
});

describe('planYaraScan', () => {
  it('empty ruleSetIds -> legacy scan with no recorded errors (DECISION W03-e)', async () => {
    await expect(planYaraScan({ deviceId: 'dev-1', agentVersion: '999.0.0', ruleSetIds: [] }))
      .resolves.toEqual({ ruleSets: [], engine: 'legacy', ruleSetErrors: null });
  });

  it('an old agent gets no ruleSets, engine legacy and an explicit agent_too_old error', async () => {
    state.sets = [pub(A, 1)];
    const plan = await planYaraScan({ deviceId: 'dev-1', agentVersion: '0.1.0', ruleSetIds: [A] });
    expect(plan.ruleSets).toEqual([]);
    expect(plan.engine).toBe('legacy');
    expect(plan.ruleSetErrors).toEqual([{ id: '*', code: 'agent_too_old', detail: expect.stringContaining(MIN_AGENT_VERSION_YARA_SCAN) }]);
    expect(state.setQueries).toBe(0);
  });

  it('a new agent with usable sets -> yara, carrying any per-set errors', async () => {
    state.sets = [pub(A, 1)];
    const plan = await planYaraScan({ deviceId: 'dev-1', agentVersion: '999.0.0', ruleSetIds: [A, D] });
    expect(plan.engine).toBe('yara');
    expect(plan.ruleSets.map((r) => r.id)).toEqual([A]);
    expect(plan.ruleSetErrors).toEqual([{ id: D, code: 'not_found' }]);
  });

  it('a new agent whose every set is unusable -> legacy with the reasons recorded', async () => {
    state.sets = [pub(A, 1, { enabled: false })];
    const plan = await planYaraScan({ deviceId: 'dev-1', agentVersion: '999.0.0', ruleSetIds: [A] });
    expect(plan).toEqual({ ruleSets: [], engine: 'legacy', ruleSetErrors: [{ id: A, code: 'disabled' }] });
  });
});
