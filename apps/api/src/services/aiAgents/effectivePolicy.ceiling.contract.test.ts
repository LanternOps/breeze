// C3 (release-blocking) — partner `supervisedActionKeys` are a CEILING (what
// an org MAY be granted), never an inherited GRANT (what it HAS). Only an org
// row is a grant; promotion is the only writer that adds a key to one,
// demotion the only one that removes one. `attemptPolicyDecision` is the sole
// consumer of the effective set, and it is safe to land this now because
// `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` is off in production and re-read
// live (`policyDecide.ts`).
//
// This file is a standalone contract, separate from effectivePolicy.test.ts's
// broader tighten-only suite, so the ceiling rule and the `promoteThreshold`
// max-merge exception each have one dedicated, exhaustive home future
// changes must keep green.
import { describe, expect, it, vi } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentLimits, type AiAgentPolicy } from '@breeze/shared';

// effectivePolicy.ts imports '../../db' at module scope (postgres pool
// construction). Mock it before importing so this pure-function contract
// test never opens a real connection — mirrors effectivePolicy.test.ts.
vi.mock('../../db', () => ({
  db: {},
  getCurrentDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));

import { mergeAgentPolicies, normalizeAgentPolicy } from './effectivePolicy';

const KEY_A = 'manage_services:restart';
const KEY_B = 'manage_services:stop';
const KEY_C = 'security_scan:quarantine';

function policy(over: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true,
    mode: 'act',
    model: null,
    toolAllowlist: ['run_script'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] },
    actAssets: { scriptIds: [] },
    instructions: null,
    cooldownSeconds: 300,
    ...over,
  };
}

describe('supervisedActionKeys — partner keys are a ceiling, not a grant (C3)', () => {
  it('no org row: effective supervisedActionKeys is [], never the partner list', () => {
    const partner = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A] } });

    const { effective } = mergeAgentPolicies(partner, null, { allowedModels: null });

    expect(effective.actAssets.supervisedActionKeys).toEqual([]);
    // Every other field on this fast path still passes the partner baseline
    // through unchanged — the ceiling rule is scoped to this one field.
    expect(effective.toolAllowlist).toEqual(partner.toolAllowlist);
  });

  it('org row present: effective is the intersection, unchanged from before C3', () => {
    const partner = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A, KEY_B] } });
    const org = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A, KEY_B] } });

    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.actAssets.supervisedActionKeys).toEqual([KEY_A, KEY_B]);
  });

  it('org row present with a key the partner lacks: the extra key is dropped', () => {
    const partner = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A] } });
    const org = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A, KEY_C] } });

    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.actAssets.supervisedActionKeys).toEqual([KEY_A]);
  });

  it('org row granting a key outside the partner ceiling entirely: effective is empty', () => {
    const partner = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A] } });
    const org = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_C] } });

    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    expect(effective.actAssets.supervisedActionKeys).toEqual([]);
  });
});

// `promoteThreshold` (v9) is the FIRST limit merged with Math.max instead of
// Math.min: a partner raising the bar must not be undercut by an org
// lowering it. Table-driven over every key in AI_AGENT_LIMIT_DEFAULTS so a
// future limit silently added to the max-merge exception set (or removed
// from it) fails this test loudly instead of drifting unnoticed.
const MAX_MERGED_LIMIT_KEYS = new Set<keyof AiAgentLimits>(['promoteThreshold']);
const LIMIT_KEYS = Object.keys(AI_AGENT_LIMIT_DEFAULTS) as Array<keyof AiAgentLimits>;

describe('mergeLimits — promoteThreshold merges with max, every other limit with min', () => {
  it.each(LIMIT_KEYS)('%s', (key) => {
    const high = 999;
    const low = 2;
    const partner = policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, [key]: high } });
    const org = policy({ limits: { ...AI_AGENT_LIMIT_DEFAULTS, [key]: low } });

    const { effective } = mergeAgentPolicies(partner, org, { allowedModels: null });

    const expected = MAX_MERGED_LIMIT_KEYS.has(key) ? high : low;
    expect(effective.limits[key]).toBe(expected);
  });

  it('a v8 snapshot with no promoteThreshold key reads the default (20)', () => {
    // A pre-v9 stored `limits` jsonb has no `promoteThreshold` property at
    // all (schemaVersion 8 predates the field). normalizeAgentPolicy runs
    // every row through aiAgentLimitsSchema, whose .transform() backfills
    // every missing key from AI_AGENT_LIMIT_DEFAULTS.
    const { promoteThreshold: _omit, ...v8Limits } = AI_AGENT_LIMIT_DEFAULTS;

    const normalized = normalizeAgentPolicy({
      enabled: true,
      mode: 'act',
      model: null,
      toolAllowlist: [],
      protectedResources: {},
      limits: v8Limits,
      triggers: {},
      recipients: {},
      actAssets: {},
      instructions: null,
      cooldownSeconds: 300,
    });

    expect(normalized.limits.promoteThreshold).toBe(20);
  });
});
