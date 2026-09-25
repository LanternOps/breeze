import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #6907 / #6911 — the `USER_OWNED_RELEASE_ACTIONS` registration contract for
 * EVERY `aiTools*.ts` tool module (except `aiToolsFleet.ts`, which keeps its
 * own sibling contract, `aiToolsFleet.userOwnedRelease.contract.test.ts`
 * (#6200) — it has extra fleet-specific checks: AGENT_UNREACHABLE, Zod-schema
 * reachability, and the tier-2 agent-principal-refusal contract).
 *
 * Why a repo-wide contract: the fleet one decides "agent-mintable" from the
 * TIER-3 tables only, on the premise that tier 1/2 actions never mint an
 * intent. That premise is false for an agent principal — `intentService.ts`'s
 * `agentTier2` lane (P2-1) mints a Tier-2 `supervised` intent for any agent
 * call whose resolved tier is 2, and that is exactly how the alert-triage
 * agent's `manage_alerts:resolve` suggestions reach the release worker. All
 * three mutating alert actions write `auth.user.id` into a `users` FK, so
 * under the rebuilt agent auth every approved one was a guaranteed 23503
 * (`alerts.resolved_by`, US prod 2026-09-22 and 2026-09-24). #6911 found the
 * same shape is not unique to alerts/fleet — any `aiTools*.ts` module can
 * write `auth.user.id` into a `users` FK — so this contract is generalized to
 * scan every such module, not just the two that have already shipped an
 * incident.
 *
 * The mechanical join, read from source text (no import graph, so no partial
 * db/schema mock elsewhere can make it vacuous):
 *   1. every property name that is a `users.id` FK anywhere in db/schema/
 *      (name-level over-approximation — a contract may be too loud, never
 *      too quiet; it is what catches `ml_feedback_events.actor_user_id`,
 *      written through `emitAlertStateFeedback`, not on the alert row);
 *   2. every `<prop>: auth.user.id` line in the module, attributed to its
 *      tool and to the `if (action === …)` guards open at its brace depth;
 *   3. agent-mintable = the action resolves to tier 2 (`TIER2_ACTIONS`, or
 *      the tool's registered base tier when unlisted) or tier 3
 *      (`TIER3_SUPERVISED_ACTIONS` / `TIER3_FOUR_EYES_ACTIONS`). Tier 1 never
 *      mints: the intent gate throws `tool_not_tier3` for it, agent or not.
 *
 * A qualifying `tool:action` must be in `USER_OWNED_RELEASE_ACTIONS` AND its
 * branch must check `approverReleaseMismatch(auth, context)` before the write.
 *
 * MODULES is auto-discovered (every `aiTools*.ts` under services/, excluding
 * `.test.ts` files, the `aiTools.ts` hub — a registry/re-export file with no
 * handler bodies of its own, zero `auth.user.id` occurrences — and
 * `aiToolsFleet.ts`, covered by its own contract above) so a new tool module
 * is scanned automatically; nothing to remember to add.
 */
const API_SRC = fileURLToPath(new URL('..', import.meta.url));
const SERVICES_DIR = join(API_SRC, 'services');
const GUARDRAILS_SRC = readFileSync(join(API_SRC, 'services/aiGuardrails.ts'), 'utf8');
const WORKER_SRC = readFileSync(join(API_SRC, 'jobs/intentReleaseWorker.ts'), 'utf8');

const EXCLUDED_MODULES: ReadonlySet<string> = new Set([
  'aiTools.ts', // hub/registry only — re-exports, no handler bodies, no auth.user.id writes
  'aiToolsFleet.ts', // own contract: aiToolsFleet.userOwnedRelease.contract.test.ts (#6200)
]);

const MODULES: readonly string[] = readdirSync(SERVICES_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && /^aiTools.*\.ts$/.test(e.name) && !e.name.endsWith('.test.ts'))
  .map((e) => e.name)
  .filter((name) => !EXCLUDED_MODULES.has(name))
  .sort()
  .map((name) => `services/${name}`);

/**
 * A write site whose action guard is NOT a literal `if (action === '…')` —
 * the brace-depth scan (below) only recognizes that one shape, so a write
 * gated behind a derived boolean (`isAddAction`) or an imported type-guard
 * function (`isThreatAction`) falls through to the single-action `['']`
 * fallback. `''` under-attributes those sites: the tool's REAL dispatch key
 * always carries the actual `action` string (it is a required input), so a
 * `tool:''` registration in the worker allowlist would never match a real
 * release and would silently leave the genuine `tool:add_block` /
 * `tool:kill` write unguarded — exactly the failure mode this contract
 * exists to catch.
 *
 * Each entry here is a PROVEN override, keyed by `file:line` of the write
 * site (line numbers are 1-based, matching `WriteSite.line`), read off the
 * source below rather than asserted by comment — `it('… still matches its
 * proven source')` re-checks the exact text on every run, so a refactor that
 * changes the guard shape fails loudly instead of leaving a stale alias.
 */
const ACTION_GUARD_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  // aiToolsDns.ts: the `dnsPolicies` row is created inside
  // `if (!policy && isAddAction)`, where `isAddAction = action === 'add_block'
  // || action === 'add_allow'` — a derived boolean, not a literal guard the
  // brace scan can see.
  ['services/aiToolsDns.ts:503', ['add_block', 'add_allow']],
  // aiToolsSentinelOne.ts: the `s1_threat_action` write in
  // `sentinelOne/actions.ts` (via `executeS1ThreatActionForOrg`) runs after
  // `if (!isThreatAction(action)) return …` — an imported type guard
  // (`jobs/s1Sync.ts` re-exporting `S1_THREAT_ACTIONS`), not an inline
  // literal. Its input_schema enum, `action.enum`, is the same three values
  // (proven against the s1_threat_action tool definition, not just asserted).
  ['services/aiToolsSentinelOne.ts:461', ['kill', 'quarantine', 'rollback']],
  // aiToolsCisBenchmark.ts: apply_cis_remediation is single-purpose (no
  // dispatch multiplexing — no `if (action === …)` anywhere in the handler),
  // but its OWN input_schema still accepts an `action` field ('apply' /
  // 'rollback', defaulted to 'apply' when omitted:
  // `input.action === 'rollback' ? 'rollback' : 'apply'`). The worker's
  // `userOwnedReleaseKey` reads the RAW `args.action` off the intent's
  // original call arguments, independent of any handler dispatch — so a
  // caller that actually sends `action: 'rollback'` produces the release key
  // `apply_cis_remediation:rollback`, not the tool-name-only
  // `apply_cis_remediation:` this file's own allowlist entry covers. Both
  // values (and the omitted/default case) reach the identical unguarded
  // `approvedBy`/`requestedBy` insert, so all three keys are required.
  ['services/aiToolsCisBenchmark.ts:519', ['', 'apply', 'rollback']],
  ['services/aiToolsCisBenchmark.ts:522', ['', 'apply', 'rollback']],
]);

/**
 * A qualifying (usersFk-named, agent-mintable) write site that is NOT a real
 * bug — #6911's triage outcomes (b) and (c):
 *
 *   (b) agent-denied entirely: the tool is in `AGENT_HUMAN_ONLY_TOOLS`
 *       (`checkAgentGuardrails`, aiGuardrails.ts), so an `ai_agent` principal
 *       can never reach the handler at all, whatever its tier/allowlist say.
 *   (c) not actually a users-FK write at release time: the line matches the
 *       `<prop>: auth.user.id` regex, but the value never reaches the column
 *       raw — either it is threaded through a resolver that already
 *       degrades a non-`users` id to NULL before the insert
 *       (`resolveCommandCreatedBy` in `services/commandQueue.ts`, or an
 *       inline "probe-and-degrade" doing the same thing), or the property
 *       sits inside a `jsonb` column (metadata/details/event payload), which
 *       Postgres cannot foreign-key at all — the name match is a coincidence
 *       with an unrelated table's real FK column of the same name.
 *
 * Each entry is proven, not just asserted: `it('every SAFE_WRITE_SITES entry
 * still matches its proven source')` re-checks the cited text on every run.
 * Keyed by `file:line` like ACTION_GUARD_ALIASES.
 */
const SAFE_WRITE_SITES: ReadonlyMap<string, string> = new Map([
  // (c) — set_agent_log_level / capture_agent_pprof: `userId` is an
  // `aiQueueCommandForExecution`/`aiExecuteCommand` option, not a column
  // write. Both route through commandQueue.ts's `queueCommand`, which calls
  // `resolveCommandCreatedBy` before the `device_commands.created_by` insert
  // — a synthetic (aiAgents) id degrades to NULL there instead of reaching
  // the FK raw.
  ['services/aiToolsAgentLogs.ts:294', 'aiQueueCommandForExecution -> resolveCommandCreatedBy degrade, not a raw column write'],
  ['services/aiToolsAgentLogs.ts:378', 'aiExecuteCommand -> resolveCommandCreatedBy degrade, not a raw column write'],
  // (c) — trigger_agent_upgrade / trigger_agent_restart: same aiExecuteCommand
  // -> resolveCommandCreatedBy path.
  ['services/aiToolsAgentMgmt.ts:439', 'aiExecuteCommand -> resolveCommandCreatedBy degrade, not a raw column write'],
  ['services/aiToolsAgentMgmt.ts:537', 'aiExecuteCommand -> resolveCommandCreatedBy degrade, not a raw column write'],
  // (b) — manage_ai_agents is in AGENT_HUMAN_ONLY_TOOLS: an ai_agent
  // principal is refused in checkAgentGuardrails before the handler runs at
  // all (P2-5, #4192 — the tool GRANTS agent authority, so an agent must
  // never reach it under any tier/allowlist configuration).
  ['services/aiToolsAiAgentGovernance.ts:315', 'manage_ai_agents is in AGENT_HUMAN_ONLY_TOOLS — unconditionally agent-denied'],
  // (c) — manage_browser_policy:apply: same aiDispatchDeviceCommand ->
  // queueCommand -> resolveCommandCreatedBy path (create is a real bug,
  // fixed separately with approverReleaseMismatch).
  ['services/aiToolsBrowser.ts:625', 'aiDispatchDeviceCommand -> resolveCommandCreatedBy degrade, not a raw column write'],
  // (c) — test_webhook: `userId` lives only in the in-memory `event.metadata`
  // object handed to the webhook worker's queueDelivery; the actual
  // `webhookDeliveries` DB insert a few lines above never includes it.
  ['services/aiToolsIntegrations.ts:331', 'userId is in the webhook worker event payload, never in the webhookDeliveries DB insert'],
  // (c) — execute_command / registry_operations: same aiExecuteCommand ->
  // resolveCommandCreatedBy path.
  ['services/aiToolsScripts.ts:682', 'aiExecuteCommand -> resolveCommandCreatedBy degrade, not a raw column write'],
  ['services/aiToolsScripts.ts:1658', 'aiExecuteCommand -> resolveCommandCreatedBy degrade, not a raw column write'],
  // (c) — cancel_script_execution: cancelScriptExecution's own comment says
  // it "probes-and-degrades [actorId] against users rather than raising
  // 23503" — the same resolver shape as resolveCommandCreatedBy, just local
  // to scriptCancellation.ts.
  ['services/aiToolsScripts.ts:775', 'cancelScriptExecution probes-and-degrades actorId against users, not a raw column write'],
  // (c) — remediate_sensitive_data (both write sites): `updatedBy` sits
  // inside `remediationMetadata`, a `jsonb` column on `sensitive_data_findings`
  // (db/schema/sensitiveData.ts) — no FK constraint exists on a JSON key.
  ['services/aiToolsSecurity.ts:624', 'updatedBy is inside sensitiveDataFindings.remediationMetadata, a jsonb column — no FK'],
  ['services/aiToolsSecurity.ts:713', 'updatedBy is inside sensitiveDataFindings.remediationMetadata, a jsonb column — no FK'],
  // (c) — assign_security_training: `assignedBy` sits inside
  // `userRiskEvents.details`, a `jsonb` column (db/schema/userRisk.ts) — no
  // FK constraint exists on a JSON key.
  ['services/aiToolsUserRisk.ts:355', 'assignedBy is inside userRiskEvents.details, a jsonb column — no FK'],
]);

function usersFkPropertyNames(): ReadonlySet<string> {
  const dir = join(API_SRC, 'db/schema');
  const names = new Set<string>();
  const re = /(\w+)\s*:\s*uuid\(\s*'[^']+'\s*\)[^,\n]*\.references\(\s*\(\s*\)\s*=>\s*users\.id/g;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    for (const m of readFileSync(join(dir, entry.name), 'utf8').matchAll(re)) names.add(m[1]!);
  }
  return names;
}

function tierPairs(listName: string): ReadonlySet<string> {
  const start = GUARDRAILS_SRC.indexOf(`const ${listName}`);
  expect(start, `${listName} not found in aiGuardrails.ts — this contract's tier source moved`).toBeGreaterThan(-1);
  const body = GUARDRAILS_SRC.slice(start, GUARDRAILS_SRC.indexOf('\n};', start));
  const pairs = new Set<string>();
  for (const m of body.matchAll(/^\s{2}(\w+)\s*:\s*\[([^\]]*)\]/gm)) {
    for (const a of m[2]!.matchAll(/'([^']+)'/g)) pairs.add(`${m[1]}:${a[1]}`);
  }
  return pairs;
}

function workerAllowlist(): ReadonlySet<string> {
  const start = WORKER_SRC.indexOf('const USER_OWNED_RELEASE_ACTIONS');
  expect(start, 'USER_OWNED_RELEASE_ACTIONS not found in jobs/intentReleaseWorker.ts').toBeGreaterThan(-1);
  // Strip line comments first: an apostrophe in a comment (`the agent's`)
  // would otherwise pair with a real quote and swallow an entry (#6907).
  const body = WORKER_SRC.slice(start, WORKER_SRC.indexOf(']);', start)).replace(/\/\/.*$/gm, '');
  return new Set([...body.matchAll(/'([^']+:[^']*)'/g)].map((m) => m[1]!));
}

interface WriteSite {
  file: string;
  line: number;
  property: string;
  tool: string;
  baseTier: number | null;
  actions: string[];
  /** Source from the innermost open action guard down to the write. */
  branch: string;
}

/**
 * Same brace-depth attribution as the fleet contract: a write's actions are
 * the INTERSECTION of every `if (action === …)` guard still open at its depth.
 * A tool opens at its `tier: N` registration line (which precedes `name:`)
 * and is named by the definition's `name: '<tool>'`.
 *
 * The tier-declaration form varies across modules: `tier: N,` (most modules,
 * e.g. aiToolsFleet.ts, aiToolsScripts.ts, aiToolsPam.ts, aiToolsNetwork.ts),
 * `tier: N as AiToolTier,` (aiToolsAlerts.ts and several others), and
 * `tier: N, domain: '...', deviceArgs: [],` — more than one property on the
 * line (aiToolsAiAgentGovernance.ts). The regex below matches all three: the
 * `as AiToolTier` cast is optional, and matching is anchored on the trailing
 * comma rather than end-of-line so trailing sibling properties don't defeat
 * it. It intentionally does NOT match a bare `tier` with no immediate comma
 * (e.g. mid-expression) — if a module's tier declarations don't fit this
 * shape at all, `baseTier` stays null and its sites are still collected
 * (unattributed baseTier only affects the tier-2-via-base-tier fallback in
 * `agentMintable`, not action attribution or FK detection), so a genuinely
 * unparseable file surfaces as a gap to investigate rather than silently
 * contributing zero sites.
 */
function writeSites(file: string): WriteSite[] {
  const lines = readFileSync(join(API_SRC, file), 'utf8').split('\n');
  const sites: WriteSite[] = [];
  let tool: string | null = null;
  let baseTier: number | null = null;
  let toolStartLine = 0;
  let depth = 0;
  let guards: { depth: number; line: number; actions: string[] }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const tierDecl = /^\s*tier:\s*(\d)(?:\s+as\s+AiToolTier)?\s*,/.exec(line);
    if (tierDecl) {
      baseTier = Number(tierDecl[1]);
      tool = null;
      toolStartLine = i;
      depth = 0;
      guards = [];
    }
    const name = /^\s*name:\s*'([a-z0-9_]+)'/.exec(line);
    if (name && tool === null) tool = name[1]!;

    const write = /^\s*(\w+)\s*:\s*auth\.user\.id\s*,?\s*$/.exec(line);
    if (write && tool) {
      const aliasKey = `${file}:${i + 1}`;
      const alias = ACTION_GUARD_ALIASES.get(aliasKey);
      // No open `if (action === …)` guard: either (a) the write belongs to a
      // single-action tool (no action multiplexing), which is exactly the
      // shape `userOwnedReleaseKey` in intentReleaseWorker.ts handles too —
      // `args.action` is absent, so the release key is `<tool>:` (empty
      // action) — or (b) the guard exists but isn't a literal `action ===`
      // comparison (a derived boolean or an imported type guard), proven and
      // named explicitly in ACTION_GUARD_ALIASES instead. Modelling the
      // no-alias case as `['']` (instead of dropping it, as the old
      // alerts-only scan implicitly did) keeps the "every agent-mintable
      // write is registered" check from silently skipping non-multiplexed
      // tools.
      const actions = guards.length
        ? guards.map((g) => g.actions).reduce((acc, a) => acc.filter((x) => a.includes(x)))
        : (alias ? [...alias] : ['']);
      // With no open guard, fall back to the tool's own registration line
      // rather than `i` (an empty range) — an `approverReleaseMismatch` guard
      // added anywhere in the handler body (the common case for a
      // single-action tool with no nested `if (action === …)` block at all)
      // must still land inside the scanned `branch` text.
      const from = guards.length ? guards[guards.length - 1]!.line : toolStartLine;
      sites.push({
        file, line: i + 1, property: write[1]!, tool, baseTier, actions,
        branch: lines.slice(from, i).join('\n'),
      });
    }

    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (/^\s*(\}\s*else\s*)?if\s*\(\s*action\s*===/.test(line)) {
      guards.push({ depth, line: i, actions: [...line.matchAll(/action\s*===\s*'([^']+)'/g)].map((m) => m[1]!) });
    }
    guards = guards.filter((g) => g.depth <= depth);
  }
  return sites;
}

describe('agent-mintable users-FK writes are user-owned on release (#6907, #6911)', () => {
  const usersFk = usersFkPropertyNames();
  const tier2 = tierPairs('TIER2_ACTIONS');
  const tier3 = new Set([...tierPairs('TIER3_SUPERVISED_ACTIONS'), ...tierPairs('TIER3_FOUR_EYES_ACTIONS')]);
  const allowlist = workerAllowlist();
  const sites = MODULES.flatMap(writeSites);

  function agentMintable(tool: string, action: string, baseTier: number | null): boolean {
    const key = `${tool}:${action}`;
    if (tier3.has(key) || tier2.has(key)) return true;
    // Unlisted actions resolve to the tool's registered base tier.
    return baseTier !== null && baseTier >= 2;
  }

  const qualifying = sites.filter((s) => usersFk.has(s.property));

  it('every ACTION_GUARD_ALIASES entry still matches its proven source', () => {
    const dnsSrc = readFileSync(join(API_SRC, 'services/aiToolsDns.ts'), 'utf8');
    expect(dnsSrc).toMatch(/const isAddAction = action === 'add_block' \|\| action === 'add_allow';/);
    const s1Src = readFileSync(join(API_SRC, 'services/aiToolsSentinelOne.ts'), 'utf8');
    expect(s1Src).toMatch(/if \(!isThreatAction\(action\)\) {/);
    const s1ActionEnum = /name: 's1_threat_action'[\s\S]*?action:\s*{\s*type:\s*'string',\s*enum:\s*\[([^\]]*)\]/.exec(s1Src);
    expect(s1ActionEnum, "s1_threat_action's input_schema action enum moved").not.toBeNull();
    expect([...s1ActionEnum![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(['kill', 'quarantine', 'rollback']);

    const cisSrc = readFileSync(join(API_SRC, 'services/aiToolsCisBenchmark.ts'), 'utf8');
    const cisActionEnum = /name: 'apply_cis_remediation'[\s\S]*?action:\s*{\s*type:\s*'string',\s*enum:\s*\[([^\]]*)\]/.exec(cisSrc);
    expect(cisActionEnum, "apply_cis_remediation's input_schema action enum moved").not.toBeNull();
    expect([...cisActionEnum![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual(['apply', 'rollback']);
    expect(cisSrc).toMatch(/input\.action === 'rollback' \? 'rollback' : 'apply'/);
  });

  it('every SAFE_WRITE_SITES entry still matches its proven source', () => {
    const commandQueueSrc = readFileSync(join(API_SRC, 'services/commandQueue.ts'), 'utf8');
    expect(commandQueueSrc).toMatch(/export async function resolveCommandCreatedBy/);

    const agentLogsSrc = readFileSync(join(API_SRC, 'services/aiToolsAgentLogs.ts'), 'utf8');
    expect(agentLogsSrc).toMatch(/aiQueueCommandForExecution\(auth, 'set_agent_log_level'/);
    expect(agentLogsSrc).toMatch(/aiExecuteCommand\(auth, 'capture_agent_pprof'/);

    const agentMgmtSrc = readFileSync(join(API_SRC, 'services/aiToolsAgentMgmt.ts'), 'utf8');
    expect(agentMgmtSrc).toMatch(/aiExecuteCommand\(auth, 'trigger_agent_upgrade'/);
    expect(agentMgmtSrc).toMatch(/aiExecuteCommand\(auth, 'trigger_agent_restart'/);

    expect(GUARDRAILS_SRC).toMatch(/export const AGENT_HUMAN_ONLY_TOOLS = new Set<string>\(\[\s*\n\s*'manage_ai_agents',/);

    const browserSrc = readFileSync(join(API_SRC, 'services/aiToolsBrowser.ts'), 'utf8');
    expect(browserSrc).toMatch(/aiDispatchDeviceCommand\(auth, 'manage_browser_policy'/);

    const integrationsSrc = readFileSync(join(API_SRC, 'services/aiToolsIntegrations.ts'), 'utf8');
    expect(integrationsSrc).toMatch(/insert\(webhookDeliveries\)/);
    // The DB insert values block must NOT mention userId — only the
    // in-memory `event.metadata` a few lines below does.
    const deliveryInsert = /insert\(webhookDeliveries\)[\s\S]*?\.returning/.exec(integrationsSrc);
    expect(deliveryInsert, 'webhookDeliveries insert moved').not.toBeNull();
    expect(deliveryInsert![0]).not.toMatch(/userId/);

    const scriptsSrc = readFileSync(join(API_SRC, 'services/aiToolsScripts.ts'), 'utf8');
    expect(scriptsSrc).toMatch(/aiExecuteCommand\(auth, 'execute_command'/);
    expect(scriptsSrc).toMatch(/aiExecuteCommand\(auth, 'registry_operations'/);
    expect(scriptsSrc).toMatch(/probes-and-degrades it\s*\n\s*\/\/\s*against `users`/);

    const securitySrc = readFileSync(join(API_SRC, 'services/aiToolsSecurity.ts'), 'utf8');
    const sensitiveDataSchema = readFileSync(join(API_SRC, 'db/schema/sensitiveData.ts'), 'utf8');
    expect(securitySrc.match(/updatedBy: auth\.user\.id,/g)?.length).toBe(2);
    expect(sensitiveDataSchema).toMatch(/remediationMetadata: jsonb\('remediation_metadata'\)/);

    const userRiskScoringSrc = readFileSync(join(API_SRC, 'services/userRiskScoring.ts'), 'utf8');
    const userRiskSchema = readFileSync(join(API_SRC, 'db/schema/userRisk.ts'), 'utf8');
    expect(userRiskScoringSrc).toMatch(/assignedBy: input\.assignedBy/);
    expect(userRiskSchema).toMatch(/details: jsonb\('details'\)/);
  });

  it('finds the known sites (guards against a vacuous pass)', () => {
    expect(usersFk.has('resolvedBy')).toBe(true);
    expect(usersFk.has('acknowledgedBy')).toBe(true);
    // ml_feedback_events.actor_user_id — the write suppress makes.
    expect(usersFk.has('actorUserId')).toBe(true);
    expect(tier2.has('manage_alerts:resolve')).toBe(true);

    const found = new Set(
      qualifying.filter((s) => s.tool === 'manage_alerts').flatMap((s) => s.actions.map((a) => `${s.property}@${a}`)),
    );
    expect([...found].sort()).toEqual([
      'acknowledgedBy@acknowledge',
      'actorUserId@acknowledge',
      'actorUserId@resolve',
      'actorUserId@suppress',
      'resolvedBy@resolve',
    ]);
    // Every site resolved to a tool and at least one action guard (or the
    // single-action `['']` fallback above — never a genuinely empty set).
    expect(qualifying.filter((s) => s.actions.length === 0)).toEqual([]);

    // Repo-wide anti-vacuity: MODULES auto-discovers every aiTools*.ts file
    // (minus the hub and fleet's own contract). Pin a floor on both the
    // module count and the total write-site count so a readdirSync/regex
    // regression that silently narrows the scan back to one file — or stops
    // matching write lines at all — fails loudly instead of passing empty.
    expect(MODULES.length).toBeGreaterThanOrEqual(30);
    expect(MODULES).toContain('services/aiToolsAlerts.ts');
    expect(MODULES).not.toContain('services/aiTools.ts');
    expect(MODULES).not.toContain('services/aiToolsFleet.ts');
    expect(sites.length).toBeGreaterThanOrEqual(30);
    // At least one non-alerts module must have contributed a qualifying
    // (usersFk) write site — otherwise the generalization did nothing.
    expect(qualifying.some((s) => s.file !== 'services/aiToolsAlerts.ts')).toBe(true);
  });

  /**
   * A tier-3 write has an approver to substitute (the intent's own
   * decidedByUserId) — USER_OWNED_RELEASE_ACTIONS + approverReleaseMismatch
   * is the only sound fix. A tier-2 write minted via the `agentTier2` lane
   * has no approver in every case: alerts' #6907 fix chose approver
   * substitution (acknowledge/resolve/suppress genuinely go through release),
   * while fleet's #6206 fix chose to refuse the ai_agent principal outright
   * before the write ever happens, for its own tier-2 actions — both are
   * sound, and which one applies is a per-action product decision, not
   * something derivable from tier alone. So a tier-2-only (non-tier-3)
   * qualifying site satisfies this contract either way: registered in
   * USER_OWNED_RELEASE_ACTIONS (checked for its approverReleaseMismatch
   * guard below, same as tier 3), OR refused for an agent principal before
   * the write (`isAiAgentPrincipal(auth)` / `isAgentPrincipalCaller(auth)`
   * followed by a `return`, mirroring aiToolsFleet.ts's
   * `isAgentPrincipalCaller` -> `refuseFleetAgentPrincipal` pair, #6206).
   */
  function hasAgentPrincipalRefusal(branch: string): boolean {
    const m = /isA(?:gentPrincipalCaller|iAgentPrincipal)\(\s*auth(?:\.principal)?\s*\)/.exec(branch);
    if (!m) return false;
    return /return\b/.test(branch.slice(m.index));
  }

  it('every agent-mintable users-FK write is in USER_OWNED_RELEASE_ACTIONS, or (tier 2 only) refuses an agent principal', () => {
    const missing: string[] = [];
    for (const site of qualifying) {
      if (SAFE_WRITE_SITES.has(`${site.file}:${site.line}`)) continue;
      for (const action of site.actions) {
        if (!agentMintable(site.tool, action, site.baseTier)) continue;
        const key = `${site.tool}:${action}`;
        if (allowlist.has(key)) continue;
        // A whole-tool base-Tier-3 registration (e.g. manage_browser_policy,
        // create_remote_session, s1_isolate_device) is real tier 3 exactly
        // like a TIER3_*_ACTIONS entry — checkGuardrails resolves it from
        // `baseTier === 3` when the action isn't itself downgraded by
        // TIER1_ACTIONS/TIER2_ACTIONS (neither table lists any action of the
        // tools this contract has had to register, so this fallback holds).
        // Missing this would let a real tier-3 write pass on a refusal-only
        // fix, which is unsound: it still mints and releases an approved
        // intent under the rebuilt agent auth, refusal or not.
        const isTier3 = tier3.has(key) || site.baseTier === 3;
        if (!isTier3 && hasAgentPrincipalRefusal(site.branch)) continue;
        missing.push(`${key} writes ${site.property} (users FK) at ${site.file}:${site.line}`);
      }
    }
    expect(
      [...new Set(missing)],
      'These tool branches store auth.user.id in a users FK and an agent can mint them as an action ' +
        'intent (tier 2 via the agentTier2 lane, or tier 3). Released under the rebuilt agent auth that id ' +
        'is an aiAgents.id, so the write is a guaranteed 23503 (#6200, #6907). Add each to ' +
        'USER_OWNED_RELEASE_ACTIONS in jobs/intentReleaseWorker.ts with its own release test and an ' +
        'approverReleaseMismatch() guard in the branch — or, for a tier-2-only action with no approver to ' +
        'substitute, refuse an ai_agent principal before the write (#6206).',
    ).toEqual([]);
  });

  it('every allowlisted action of a scanned tool guards on approverReleaseMismatch before its writes', () => {
    const scannedTools = new Set(sites.map((s) => s.tool));
    const unguarded: string[] = [];
    for (const key of allowlist) {
      const [tool, action] = key.split(':') as [string, string];
      if (!scannedTools.has(tool)) continue;
      const branchSites = qualifying.filter((s) => s.tool === tool && s.actions.includes(action));
      if (branchSites.length === 0) {
        unguarded.push(`${key} (stale: no users-FK write in the scanned module)`);
        continue;
      }
      for (const site of branchSites) {
        if (!/approverReleaseMismatch\(\s*auth\s*,\s*context\s*\)/.test(site.branch)) {
          unguarded.push(`${key} (no approverReleaseMismatch(auth, context) before ${site.file}:${site.line})`);
        }
      }
    }
    expect(unguarded, JSON.stringify(unguarded, null, 2)).toEqual([]);
  });
});
