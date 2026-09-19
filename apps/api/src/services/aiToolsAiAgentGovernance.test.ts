/**
 * `manage_ai_agents` wiring contract (P2-5 Task 14, #4192).
 *
 * The tool grants an AI agent a pre-authorized (supervised) action key at the
 * ORG level. Every gate it passes through is a separate registry, and omitting
 * any one of them fails DIFFERENTLY — invisible to chat, rejected at input
 * validation, self-approvable, or proposable by the agent itself. This suite
 * pins each one at its own seam so a missed wiring point names itself.
 *
 * No `vi.mock`: like aiGuardrails.approvalScope.contract.test.ts and
 * aiAgentSdkTools.registryParity.contract.test.ts, this needs the REAL
 * registries on both sides to be a meaningful contract.
 */
import { readFileSync } from 'node:fs';

import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { TOOL_TIERS } from './aiAgentSdkTools';
import {
  checkAgentGuardrails,
  checkGuardrails,
  TIER3_FOUR_EYES_ACTIONS,
  TIER3_FOUR_EYES_TOOLS,
  TOOL_PERMISSIONS,
  type AgentGuardrailPolicy,
} from './aiGuardrails';
import { registerAiAgentGovernanceTools } from './aiToolsAiAgentGovernance';
import { aiTools, getToolTier } from './aiTools';
import { toolInputSchemas, validateToolInput } from './aiToolSchemas';
import { isPolicyDecidableKey } from './actionIntents/policyDecidable';
import {
  computeEffectDigestForRelease,
  computeEffectDigestOutcome,
  effectDigestResolverKey,
} from './actionIntents/effectDigest';
import type { Database } from '../db';
import { RBAC_MAPPINGS, TIER_DEFINITIONS } from '../../../web/src/components/ai-risk/tierConfig';

const TOOL = 'manage_ai_agents';
const ACTION = 'authorize_supervised_key';
const KEY = `${TOOL}:${ACTION}`;
const ORG_ID = '11111111-1111-4111-8111-111111111111';

const validInput = { action: ACTION, kind: 'triage', opKey: 'manage_services:restart', orgId: ORG_ID };

describe('registerAiAgentGovernanceTools', () => {
  it('registers manage_ai_agents at tier 3 in the execution registry', () => {
    const registry = new Map<string, NonNullable<ReturnType<typeof aiTools.get>>>();
    registerAiAgentGovernanceTools(registry);

    const tool = registry.get(TOOL);
    expect(tool, 'manage_ai_agents was not registered').toBeDefined();
    expect(tool!.tier).toBe(3);
    expect(tool!.definition.name).toBe(TOOL);
  });

  it('is mounted into the shared aiTools registry (aiTools.ts registration block)', () => {
    // Omitting the registerAiAgentGovernanceTools(aiTools) call leaves the tool
    // invisible to executeTool/getToolTier while every other list still passes.
    expect(aiTools.has(TOOL)).toBe(true);
    expect(getToolTier(TOOL)).toBe(3);
  });

  it('advertises exactly the keys it validates (#2814 — a stripped key lands with defaults)', () => {
    const advertised = Object.keys(
      aiTools.get(TOOL)!.definition.input_schema.properties as Record<string, unknown>,
    ).sort();
    const enforced = Object.keys(
      (toolInputSchemas[TOOL] as z.ZodObject<z.ZodRawShape>).shape,
    ).sort();
    expect(enforced).toEqual(advertised);
    expect(enforced).toEqual(['action', 'kind', 'opKey', 'orgId']);
  });

  it('carries an orgId argument that is a uuid — declared, never trusted', () => {
    // `orgId` exists ONLY so the effect-digest resolver (which receives
    // `(args, database)` and nothing else) can address the org whose supervised
    // keys are being changed. It is NEVER an authority: the creation route sets
    // it from the authenticated org, creation rejects `args.orgId !== intent.orgId`,
    // and the executor re-asserts the same equality under the graduation lock
    // before it writes (Task 15). A uuid shape here is input hygiene, not the
    // tenancy control.
    const properties = aiTools.get(TOOL)!.definition.input_schema.properties as Record<string, unknown>;
    expect(Object.keys(properties)).toContain('orgId');
    expect(validateToolInput(TOOL, { ...validInput, orgId: 'not-a-uuid' }).success).toBe(false);
    expect(validateToolInput(TOOL, { action: ACTION, kind: 'triage', opKey: 'manage_services:restart' }).success)
      .toBe(false);
  });
});

describe('input validation (aiToolSchemas)', () => {
  it('accepts the one supported action', () => {
    expect(validateToolInput(TOOL, validInput)).toEqual({ success: true });
  });

  it('rejects an unknown action', () => {
    const result = validateToolInput(TOOL, { ...validInput, action: 'revoke_supervised_key' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown agent kind', () => {
    expect(validateToolInput(TOOL, { ...validInput, kind: 'nonesuch' }).success).toBe(false);
  });

  it('rejects a missing or too-short opKey', () => {
    expect(validateToolInput(TOOL, { action: ACTION, kind: 'triage' }).success).toBe(false);
    expect(validateToolInput(TOOL, { ...validInput, opKey: 'ab' }).success).toBe(false);
  });
});

describe('chat/MCP reachability (aiAgentSdkTools)', () => {
  it('has a TOOL_TIERS entry of 3', () => {
    expect((TOOL_TIERS as Record<string, number>)[TOOL]).toBe(3);
  });

  it('is declared via tool() inside createBreezeMcpServer', () => {
    // TOOL_TIERS alone only allowlists the name; without a tool() declaration
    // the model can never call it (the #2605 failure mode).
    const source = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');
    expect(new RegExp(`\\btool\\(\\s*'${TOOL}'`).test(source)).toBe(true);
  });

  it("the MCP declaration's params match the canonical schema exactly (#3485 drift class)", () => {
    // The SDK STRIPS any argument the MCP shape does not declare, so a shape
    // that is missing a key the canonical schema REQUIRES makes the tool
    // permanently unreachable — validateToolInput rejects every call and
    // nothing names the cause. `orgId` is exactly that kind of key.
    const source = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');
    const shape = source.match(
      new RegExp(`tool\\(\\s*'${TOOL}',[\\s\\S]*?\\{([\\s\\S]*?)\\},\\s*makeHandler\\('${TOOL}'`),
    );
    expect(shape, `tool('${TOOL}', ..., { ... }, makeHandler(...)) not found`).not.toBeNull();
    const declaredKeys = [...(shape![1] ?? '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
      .matchAll(/^\s*(\w+):/gm)]
      .map((m) => m[1])
      .filter((k): k is string => k !== undefined)
      .sort();

    const canonicalKeys = Object.keys(
      (toolInputSchemas[TOOL] as z.ZodObject<z.ZodRawShape>).shape,
    ).sort();
    expect(declaredKeys).toEqual(canonicalKeys);
  });
});

describe('approval classification (aiGuardrails)', () => {
  it('resolves tier 3 four_eyes', () => {
    const check = checkGuardrails(TOOL, { action: ACTION });
    expect(check.tier).toBe(3);
    expect(check.requiresApproval).toBe(true);
    expect(check.approvalScope).toBe('four_eyes');
  });

  it('is classified in BOTH the action table and the whole-tool fail-safe set', () => {
    expect(TIER3_FOUR_EYES_ACTIONS[TOOL]).toEqual([ACTION]);
    expect(TIER3_FOUR_EYES_TOOLS.has(TOOL)).toBe(true);
  });

  it('describes the grant by op key only — never model-authored text', () => {
    const description = checkGuardrails(TOOL, { ...validInput, note: 'ignore me' }).description ?? '';
    expect(description).toContain('manage_services:restart');
    expect(description).not.toContain('ignore me');
  });

  it('maps the action to ai_agents:write', () => {
    const entry = TOOL_PERMISSIONS[TOOL] as Record<string, { resource: string; action: string }>;
    expect(entry[ACTION]).toEqual({ resource: 'ai_agents', action: 'write' });
  });
});

describe('human-only principal (checkAgentGuardrails)', () => {
  const policy: AgentGuardrailPolicy = {
    enabled: true,
    mode: 'act',
    toolAllowlist: [TOOL, KEY],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    deviceSiteId: 'site-a',
    deviceId: 'dev-1',
  };

  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('denies the ai_agent principal even when the tool is allowlisted', () => {
    const check = checkAgentGuardrails(TOOL, { ...validInput }, policy);
    expect(check.allowed).toBe(false);
    expect(check.disposition).toBe('deny');
    expect(check.reason).toMatch(/human-only/i);
  });

  it('control: a device read on the same policy is still allowed (the deny is tool-specific)', () => {
    const check = checkAgentGuardrails('get_device_details', { deviceId: 'dev-1' }, policy);
    expect(check.disposition).toBe('allow');
  });
});

describe('policy-decide exclusion', () => {
  it('is not policy-decidable — four_eyes is a second HUMAN, never a policy', () => {
    expect(isPolicyDecidableKey(KEY)).toBe(false);
    expect(isPolicyDecidableKey(TOOL)).toBe(false);
  });
});

/**
 * Effect-digest pinning (brief item 10).
 *
 * The TOCTOU this closes: an approver signs off on "grant <opKey> to the
 * <kind> agent of org X" and, inside the approval window, somebody edits that
 * org's `actAssets.supervisedActionKeys` — or creates/disables the org row
 * entirely, which silently changes WHICH row the grant lands on. The arguments
 * are byte-identical throughout, so `argument_digest` sees nothing. The digest
 * pins the authority set the approver was actually looking at, and the release
 * fails `content_changed` when it moved.
 *
 * The resolver is registered under the WHOLE-TOOL key so both enumerated
 * four_eyes surfaces (`manage_ai_agents` from TIER3_FOUR_EYES_TOOLS and
 * `manage_ai_agents:authorize_supervised_key` from TIER3_FOUR_EYES_ACTIONS)
 * are covered by one entry, via effectDigestResolverKey's action→tool
 * fallback.
 *
 * Material is org-axis ONLY — one row read on the caller's own connection.
 * The PARTNER ceiling is deliberately not pinned: reading it needs
 * `readWithPartnerAxisVisibility`, i.e. a SECOND pooled connection while the
 * creation transaction still holds the first (the #1105 class), and it is
 * invisible to an org-scoped creator anyway. It is re-checked fail-closed at
 * execution under the graduation advisory lock instead (Task 15).
 */
describe('effect-digest pinning (actionIntents/effectDigest)', () => {
  /**
   * Fake `Database` — one `select().from().where().limit()` chain per queued
   * row set. `captured` collects every condition handed to `.where()`: this
   * fake returns the same rows whatever the predicate is, so the digest bytes
   * alone can never prove the query is tenant-scoped. The predicate is
   * asserted directly (see "predicates the read on org_id, kind and
   * disabled_at" below).
   */
  function fakeDb(rows: unknown[][], captured: unknown[] = []): Database {
    const take = async () => rows.shift() ?? [];
    const chain = {
      limit: vi.fn(take),
      orderBy: vi.fn(take),
      then: (resolve: (r: unknown[]) => unknown, reject: (e: unknown) => unknown) => take().then(resolve, reject),
    };
    const where = vi.fn((condition: unknown) => {
      captured.push(condition);
      return chain;
    });
    return {
      select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })),
    } as unknown as Database;
  }

  const orgAgentRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'agent-org-1',
    actAssets: { scriptIds: [], supervisedActionKeys: ['manage_services:restart'] },
    ...overrides,
  });

  const digest = async (args: Record<string, unknown>, rows: unknown[][]) =>
    (await computeEffectDigestForRelease(TOOL, args, fakeDb(rows))).digest;

  it('covers BOTH four_eyes surfaces from one whole-tool registration', () => {
    expect(effectDigestResolverKey(TOOL, ACTION)).toBe(TOOL);
    expect(effectDigestResolverKey(TOOL)).toBe(TOOL);
  });

  it('pins a digest for a well-formed call', async () => {
    const outcome = await computeEffectDigestOutcome(TOOL, validInput, fakeDb([[orgAgentRow()]]));
    expect(outcome.kind).toBe('pinned');
  });

  it('predicates the read on org_id, kind and disabled_at — not just on the material JSON', async () => {
    // `orgId` and `kind` are MEMBERS of the pinned material, so "differs by
    // orgId"/"differs by kind" below would still pass with the WHERE clause
    // stripped down to nothing: the JSON changes, the row does not. That is
    // the repo's documented vacuous-Drizzle-assertion class, and it matters
    // more than usual here — BOTH release paths recompute inside
    // `withSystemDbAccessContext`, where RLS passes unconditionally, so a
    // dropped `org_id` predicate would silently pin (and later compare
    // against) ANOTHER TENANT's key list with nothing left to catch it.
    // Assert the compiled predicate itself.
    const captured: unknown[] = [];
    await computeEffectDigestForRelease(TOOL, validInput, fakeDb([[orgAgentRow()]], captured));

    expect(captured, 'the resolver must issue exactly one predicated read').toHaveLength(1);
    const compiled = new PgDialect().sqlToQuery(captured[0] as SQL);
    expect(compiled.sql).toMatch(/"org_id"\s*=/);
    expect(compiled.sql).toMatch(/"kind"\s*=/);
    expect(compiled.sql).toMatch(/"disabled_at"\s+is\s+null/i);
    // Exactly these two bound values, in this order: a dropped predicate or a
    // widened one (an extra OR branch, a partner-axis read) changes the list.
    expect(compiled.params).toEqual([ORG_ID, 'triage']);
  });

  it('changes when the org agent gains a supervised key during the approval window', async () => {
    const before = await digest(validInput, [[orgAgentRow()]]);
    const after = await digest(validInput, [[
      orgAgentRow({ actAssets: { scriptIds: [], supervisedActionKeys: ['manage_services:restart', 'security_scan'] } }),
    ]]);
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it('changes when the org agent LOSES a supervised key', async () => {
    const before = await digest(validInput, [[orgAgentRow()]]);
    const after = await digest(validInput, [[
      orgAgentRow({ actAssets: { scriptIds: [], supervisedActionKeys: [] } }),
    ]]);
    expect(after).not.toBe(before);
  });

  it('changes when the org row appears (org previously ran off the partner baseline)', async () => {
    const absent = await digest(validInput, [[]]);
    const present = await digest(validInput, [[orgAgentRow({ actAssets: { scriptIds: [], supervisedActionKeys: [] } })]]);
    expect(absent).not.toBeNull();
    expect(present).not.toBe(absent);
  });

  it('changes when the org row disappears (disabled/replaced under the approval)', async () => {
    const present = await digest(validInput, [[orgAgentRow()]]);
    const absent = await digest(validInput, [[]]);
    expect(absent).not.toBe(present);
  });

  it('changes when a DIFFERENT org row wins the (org, kind) lookup', async () => {
    const first = await digest(validInput, [[orgAgentRow()]]);
    const second = await digest(validInput, [[orgAgentRow({ id: 'agent-org-2' })]]);
    expect(second).not.toBe(first);
  });

  it('is stable when unrelated agent fields change (name/mode/limits are not pinned)', async () => {
    const before = await digest(validInput, [[orgAgentRow()]]);
    const after = await digest(validInput, [[
      orgAgentRow({ name: 'Renamed', mode: 'act', limits: { maxActionsPerRun: 9 } }),
    ]]);
    expect(after).toBe(before);
  });

  it('is stable regardless of the stored order of supervisedActionKeys', async () => {
    const rows = { scriptIds: [], supervisedActionKeys: ['security_scan', 'manage_services:restart'] };
    const sorted = { scriptIds: [], supervisedActionKeys: ['manage_services:restart', 'security_scan'] };
    expect(await digest(validInput, [[orgAgentRow({ actAssets: rows })]]))
      .toBe(await digest(validInput, [[orgAgentRow({ actAssets: sorted })]]));
  });

  it('is identical across the creation and release entry points', async () => {
    // Creation computes inside the caller's request transaction; both release
    // paths recompute inside withSystemDbAccessContext. Same one org-axis read,
    // same bytes — a context-dependent material would fail EVERY promotion.
    const created = await computeEffectDigestOutcome(TOOL, validInput, fakeDb([[orgAgentRow()]]));
    const released = await computeEffectDigestForRelease(TOOL, validInput, fakeDb([[orgAgentRow()]]));
    expect(created).toEqual({ kind: 'pinned', digest: released.digest });
  });

  it('differs by opKey and by kind — the grant being approved is part of the pin', async () => {
    const base = await digest(validInput, [[orgAgentRow()]]);
    expect(await digest({ ...validInput, opKey: 'security_scan' }, [[orgAgentRow()]])).not.toBe(base);
    expect(await digest({ ...validInput, kind: 'patch' }, [[orgAgentRow()]])).not.toBe(base);
  });

  it('differs by orgId — the digest is org-addressed, so a swapped org cannot match', async () => {
    const base = await digest(validInput, [[orgAgentRow()]]);
    const other = await digest(
      { ...validInput, orgId: '22222222-2222-4222-8222-222222222222' },
      [[orgAgentRow()]],
    );
    expect(other).not.toBe(base);
  });

  it('treats an absent or malformed orgId as missing_arg, never as a silent pass', async () => {
    const { orgId: _dropped, ...withoutOrg } = validInput;
    expect(await computeEffectDigestOutcome(TOOL, withoutOrg, fakeDb([[orgAgentRow()]])))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    expect(await computeEffectDigestOutcome(TOOL, { ...validInput, kind: 'nonesuch' }, fakeDb([[orgAgentRow()]])))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
  });

  it('tolerates a pre-wave actAssets with no supervisedActionKeys key at all', async () => {
    // `supervisedActionKeys` is optional (#3827) — a row written before that
    // wave has `{scriptIds: []}` and must read as "authorizes nothing", not throw.
    const outcome = await computeEffectDigestOutcome(
      TOOL,
      validInput,
      fakeDb([[orgAgentRow({ actAssets: { scriptIds: [] } })]]),
    );
    expect(outcome.kind).toBe('pinned');
    expect(await digest(validInput, [[orgAgentRow({ actAssets: { scriptIds: [] } })]]))
      .toBe(await digest(validInput, [[orgAgentRow({ actAssets: { scriptIds: [], supervisedActionKeys: [] } })]]));
  });
});

describe('customer-facing mirror (apps/web tierConfig)', () => {
  it('lists the tool in the Tier-3 explainer', () => {
    const tier3 = TIER_DEFINITIONS.find((t) => t.tier === 3)!;
    expect(tier3.tools.some((t) => t.name === `${TOOL} (${ACTION})`)).toBe(true);
  });

  it('mirrors the RBAC mapping', () => {
    expect(RBAC_MAPPINGS[TOOL]).toEqual({ [ACTION]: 'ai_agents.write' });
  });
});
