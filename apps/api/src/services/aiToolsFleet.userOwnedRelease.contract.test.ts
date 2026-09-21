import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #6200 — the registration contract behind `USER_OWNED_RELEASE_ACTIONS`
 * (`jobs/intentReleaseWorker.ts`).
 *
 * A fleet tool branch that stores `auth.user.id` in a `users` FK column is
 * only correct for a HUMAN caller. An agent-originated action intent is
 * released under the rebuilt agent auth, where `auth.user.id` is an
 * `aiAgents.id` — attribution only, never a users row — so the insert is a
 * guaranteed 23503 that the approving technician sees as `execution_error`
 * seconds after their own WebAuthn approval, with the effect rolled back.
 * That shipped: three `manage_patches:install` intents failed exactly this
 * way on US prod on 2026-09-18, and the same latent hole sat under
 * `manage_deployments:create` and `manage_patches:rollback`.
 *
 * Code review has never caught this class (it is a three-file join: the
 * handler's insert, the schema's FK, and a tier table). So it is a mechanical
 * contract instead: read the three sources, compute the join, and fail when a
 * qualifying branch is missing from the worker's allowlist.
 *
 * Style follows `scriptVersions.writers.contract.test.ts` — assert on source
 * text, load no import graph, so a partial db/schema mock in another suite
 * cannot make this vacuous.
 *
 * A branch qualifies (and so MUST be user-owned on release) when all three
 * hold:
 *   1. it writes `auth.user.id` into a property that is a `users.id` FK
 *      somewhere in `db/schema/`;
 *   2. its `tool:action` is agent-mintable — a tier-3 entry in
 *      `aiGuardrails.ts`'s `TIER3_SUPERVISED_ACTIONS` or
 *      `TIER3_FOUR_EYES_ACTIONS` (tier 1/2 actions never mint an intent);
 *   3. the action is actually reachable. Reachability is read from the ZOD
 *      validator (`services/aiToolSchemasFleet.ts`), which is the real
 *      runtime gate via `validateToolInput`, NOT from the tool's JSON
 *      `input_schema` enum — that one is advisory, LLM-facing prose, and the
 *      two already disagree (`manage_patches:setup_auto_approval` is in the
 *      Zod enum but not the JSON one). Keying the exemption off the advisory
 *      list would silently excuse a genuinely reachable FK write.
 *
 * A branch whose action IS in the Zod enum but which is hard-refused before
 * any write must say so in `AGENT_UNREACHABLE` below, and the exemption is
 * itself verified against the source — it cannot be asserted by comment.
 */
const API_SRC = fileURLToPath(new URL('..', import.meta.url));

const FLEET_SRC = readFileSync(join(API_SRC, 'services/aiToolsFleet.ts'), 'utf8');
const SCHEMAS_SRC = readFileSync(join(API_SRC, 'services/aiToolSchemasFleet.ts'), 'utf8');
const GUARDRAILS_SRC = readFileSync(join(API_SRC, 'services/aiGuardrails.ts'), 'utf8');
const WORKER_SRC = readFileSync(join(API_SRC, 'jobs/intentReleaseWorker.ts'), 'utf8');

/**
 * `tool:action` pairs that pass the Zod validator but are hard-refused by the
 * handler before reaching any write, so an agent cannot actually cause the FK
 * insert. Each entry is PROVEN against the source below (a refusal naming the
 * action, positioned before the write) — an entry that stops being true fails
 * the suite rather than quietly widening the exemption.
 */
const AGENT_UNREACHABLE: ReadonlySet<string> = new Set([
  // aiToolsFleet.ts returns 'Action "setup_auto_approval" is disabled. Patch
  // policies must be managed through configuration policies.' near the top of
  // the manage_patches handler; the configuration_policies insert further down
  // is dead defense-in-depth.
  'manage_patches:setup_auto_approval',
  // #6206 review: both write a `users` FK (`maintenance_windows.created_by`,
  // `automations.created_by`) and both ARE in their tool's Zod enum, so the
  // validator admits them — but each handler refuses the action as disabled
  // ("managed through configuration policies") well above the insert, which
  // the `AGENT_UNREACHABLE` proof below re-checks against the source on every
  // run. Listed rather than skipped so the day a create action is re-enabled,
  // the suite demands an agent-principal guard instead of silently allowing a
  // 23503.
  'manage_maintenance_windows:create',
  'manage_automations:create',
]);

// ---------------------------------------------------------------------------
// 1. Every property name that is a `users.id` FK anywhere in db/schema.
//    Deliberately a name-level (not table-level) over-approximation: a
//    contract test may only ever be too LOUD, never too quiet, and the
//    handler's insert does not name its column's table in a way text can
//    join on reliably.
// ---------------------------------------------------------------------------
function usersFkPropertyNames(): ReadonlySet<string> {
  const dir = join(API_SRC, 'db/schema');
  const names = new Set<string>();
  // e.g. `createdBy: uuid('created_by').references(() => users.id, { ... })`
  const re = /(\w+)\s*:\s*uuid\(\s*'[^']+'\s*\)[^,\n]*\.references\(\s*\(\s*\)\s*=>\s*users\.id/g;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const src = readFileSync(join(dir, entry.name), 'utf8');
    for (const m of src.matchAll(re)) names.add(m[1]!);
  }
  return names;
}

// ---------------------------------------------------------------------------
// 2. Tier-3 (intent-minting) tool:action pairs.
// ---------------------------------------------------------------------------
function tier3Actions(): ReadonlySet<string> {
  const pairs = new Set<string>();
  for (const listName of ['TIER3_SUPERVISED_ACTIONS', 'TIER3_FOUR_EYES_ACTIONS']) {
    const start = GUARDRAILS_SRC.indexOf(`const ${listName}`);
    expect(start, `${listName} not found in aiGuardrails.ts — this contract's tier source moved`).toBeGreaterThan(-1);
    const body = GUARDRAILS_SRC.slice(start, GUARDRAILS_SRC.indexOf('\n};', start));
    for (const m of body.matchAll(/^\s{2}(\w+)\s*:\s*\[([^\]]*)\]/gm)) {
      for (const a of m[2]!.matchAll(/'([^']+)'/g)) pairs.add(`${m[1]}:${a[1]}`);
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// 3. Walk the fleet source: every `<prop>: auth.user.id` write, attributed to
//    the enclosing safeHandler tool and the nearest preceding
//    `action === '<x>'` guard(s). The handlers in this file are flat chains of
//    `if (action === 'x')` blocks, so "nearest preceding" is exact.
// ---------------------------------------------------------------------------
interface WriteSite {
  line: number;
  property: string;
  tool: string;
  actions: string[];
}

/**
 * The REAL reachability gate: the Zod enum `validateToolInput` enforces, read
 * from `services/aiToolSchemasFleet.ts`. An action absent here cannot reach
 * the handler at all, whatever the JSON input_schema advertises.
 */
function zodActions(tool: string): string[] {
  const at = SCHEMAS_SRC.indexOf(`${tool}: z.object({`);
  if (at < 0) return [];
  const m = /action:\s*z\.enum\(\[([^\]]*)\]\)/.exec(SCHEMAS_SRC.slice(at));
  if (!m) return [];
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((a) => a[1]!);
}

/**
 * Proves an `AGENT_UNREACHABLE` entry: the handler must refuse the action as
 * disabled at a line BEFORE the write that the exemption is excusing.
 */
function hasDisabledRefusalBefore(tool: string, action: string, writeLine: number): boolean {
  const lines = FLEET_SRC.split('\n');
  const handlerLine = lines.findIndex((l) => l.includes(`safeHandler('${tool}'`));
  if (handlerLine < 0) return false;
  for (let i = handlerLine; i < writeLine - 1; i++) {
    if (!new RegExp(`action === '${action}'`).test(lines[i]!)) continue;
    const window = lines.slice(i, Math.min(i + 6, writeLine - 1)).join('\n');
    if (/disabled/i.test(window) && /return JSON\.stringify\(\{\s*error/.test(window)) return true;
  }
  return false;
}

/**
 * Brace-depth tracking, not "nearest preceding guard": these handlers nest
 * (`if (action === 'decline' && input.allRings)` sits INSIDE the combined
 * `approve || decline || defer || bulk_approve` branch and closes again before
 * the write). A backward scan would attribute the write to whichever guard it
 * met first and silently drop the other three actions — a contract test that
 * under-reports is worse than none.
 *
 * A write's actions are the INTERSECTION of every `if (action === …)` guard
 * still open at its depth; nesting narrows.
 */
function fleetWriteSites(): WriteSite[] {
  const lines = FLEET_SRC.split('\n');
  const sites: WriteSite[] = [];
  let tool: string | null = null;
  let depth = 0;
  /** Open `if (action === …)` guards: the depth they opened at + their actions. */
  let guards: { depth: number; actions: string[] }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const handler = /safeHandler\(\s*'([^']+)'/.exec(line);
    if (handler) {
      tool = handler[1]!;
      depth = 0;
      guards = [];
    }

    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    const isGuard = /^\s*(\}\s*else\s*)?if\s*\(\s*action\s*===/.test(line);

    // The write and the guard-open both take effect at the depth AFTER this
    // line's braces are applied, so evaluate the write before pushing.
    const write = /^\s*(\w+)\s*:\s*auth\.user\.id\s*,?\s*$/.exec(line);
    if (write && tool) {
      const actions = guards.length
        ? guards.map((g) => g.actions).reduce((acc, a) => acc.filter((x) => a.includes(x)))
        : [];
      sites.push({ line: i + 1, property: write[1]!, tool, actions });
    }

    depth += opens - closes;
    if (isGuard) {
      guards.push({ depth, actions: [...line.matchAll(/action\s*===\s*'([^']+)'/g)].map((m) => m[1]!) });
    }
    guards = guards.filter((g) => g.depth <= depth);
  }
  return sites;
}

function workerAllowlist(): ReadonlySet<string> {
  const start = WORKER_SRC.indexOf('const USER_OWNED_RELEASE_ACTIONS');
  expect(start, 'USER_OWNED_RELEASE_ACTIONS not found in jobs/intentReleaseWorker.ts').toBeGreaterThan(-1);
  const body = WORKER_SRC.slice(start, WORKER_SRC.indexOf(']);', start));
  return new Set([...body.matchAll(/'([^']+:[^']*)'/g)].map((m) => m[1]!));
}

/**
 * #6206: does the handler refuse an ai_agent principal before `writeLine`?
 *
 * Structural, like `hasDisabledRefusalBefore`: the refusal must sit inside the
 * tool's own handler, above the write, and both name the principal check and
 * return. A guard that only *mentions* agents (a comment) does not count.
 */
function hasAgentPrincipalRefusalBefore(tool: string, action: string, writeLine: number): boolean {
  const lines = FLEET_SRC.split('\n');
  const handlerLine = lines.findIndex((l) => l.includes(`safeHandler('${tool}'`));
  if (handlerLine < 0) return false;
  for (let i = handlerLine; i < writeLine - 1; i++) {
    const line = lines[i]!;
    if (!/isAgentPrincipalCaller\s*\(\s*auth\s*\)/.test(line)) continue;
    // The refusal either returns on the same line or within the next two.
    const window = lines.slice(i, Math.min(i + 3, writeLine)).join('\n');
    if (!/return\s+refuseFleetAgentPrincipal\(/.test(window)) continue;
    // …and it must actually cover THIS action: either the enclosing/own guard
    // names it, or the guard chain it sits under does.
    // The guard must be qualified by THIS action — a bare, unqualified guard
    // is deliberately NOT accepted, so a refactor that hoists it above all
    // action branching cannot register as covering a site it does not protect.
    const scope = lines.slice(Math.max(handlerLine, i - 12), i + 3).join('\n');
    if (new RegExp(`action === '${action}'`).test(scope)) return true;
  }
  return false;
}

describe('aiToolsFleet users-FK writes are user-owned on release (#6200)', () => {
  const usersFk = usersFkPropertyNames();
  const tier3 = tier3Actions();
  const allowlist = workerAllowlist();
  const sites = fleetWriteSites();

  it('finds the write sites, the FK names and the tier tables (guards against a vacuous pass)', () => {
    // If a refactor breaks any of the three parses, every assertion below
    // would pass on an empty set. Pin non-emptiness and the known anchors.
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(usersFk).toContain('createdBy');
    expect(usersFk).toContain('initiatedBy');
    expect(tier3).toContain('manage_patches:install');
    expect(tier3).toContain('manage_patches:rollback');
    expect(allowlist).toContain('manage_tickets:log_time_entry');
    // Every site resolved a tool and at least one action guard.
    expect(sites.filter((s) => s.actions.length === 0)).toEqual([]);
    // Pin the guard ATTRIBUTION itself, independent of the allowlist's current
    // contents: a mis-attributing parse that still produced non-empty sets
    // would otherwise slip past every assertion below. One narrow case
    // (`create`) and the nested multi-action case that motivated brace-depth
    // tracking in the first place.
    expect(sites.find((s) => s.tool === 'manage_deployments' && s.property === 'createdBy')).toMatchObject({
      tool: 'manage_deployments',
      actions: ['create'],
    });
    // `patch_approvals.approved_by` is written from FOUR branches: the nested
    // `approve || decline` guard inside the combined partner-wide gate, plus
    // `defer` and `bulk_approve` separately. Pinning the per-site sets AND
    // their union proves the intersection narrows on nesting (the first site
    // must be exactly approve+decline, not the outer four) without depending
    // on which site the scan happens to reach first.
    const approvalSites = sites.filter((s) => s.tool === 'manage_patches' && s.property === 'approvedBy');
    expect(approvalSites.map((s) => s.actions)).toEqual([
      ['approve', 'decline'],
      ['defer'],
      ['bulk_approve'],
    ]);
    // The Zod validator is the reachability source, so it must parse.
    expect(zodActions('manage_patches')).toContain('install');
    expect(zodActions('manage_deployments')).toContain('create');
  });

  it('every AGENT_UNREACHABLE exemption is still proven by a disabled-action refusal in the source', () => {
    // An exemption asserted only by comment is how a genuinely reachable FK
    // write gets excused. Each entry must name an action the handler refuses
    // as disabled BEFORE the write it excuses — and must actually excuse a
    // write, so a stale entry is removed rather than left to rot.
    const unproven: string[] = [];
    for (const key of AGENT_UNREACHABLE) {
      const [tool, action] = key.split(':') as [string, string];
      const excused = sites.filter(
        (s) => s.tool === tool && s.actions.includes(action) && usersFk.has(s.property),
      );
      if (excused.length === 0) {
        unproven.push(`${key} (stale: no users-FK write to excuse)`);
        continue;
      }
      for (const site of excused) {
        if (!hasDisabledRefusalBefore(tool, action, site.line)) {
          unproven.push(`${key} (no disabled-action refusal before aiToolsFleet.ts:${site.line})`);
        }
      }
    }
    expect(unproven, JSON.stringify(unproven, null, 2)).toEqual([]);
  });

  it('every agent-mintable, reachable users-FK write is in USER_OWNED_RELEASE_ACTIONS', () => {
    const missing: string[] = [];
    for (const site of sites) {
      if (!usersFk.has(site.property)) continue;
      for (const action of site.actions) {
        const key = `${site.tool}:${action}`;
        if (!tier3.has(key)) continue; // tier 1/2 — never mints an intent
        // Not accepted by the Zod validator, so the handler is never reached.
        if (!zodActions(site.tool).includes(action)) continue;
        // Accepted by the validator but hard-refused before the write; the
        // exemption is proven by its own `it` above.
        if (AGENT_UNREACHABLE.has(key)) continue;
        if (!allowlist.has(key)) {
          missing.push(`${key} writes ${site.property} (users FK) at aiToolsFleet.ts:${site.line}`);
        }
      }
    }
    expect(
      missing,
      'These fleet tool branches store auth.user.id in a users FK AND are agent-mintable as a ' +
        'tier-3 action intent. Released under the rebuilt agent auth that id is an aiAgents.id, ' +
        'so the insert is a guaranteed 23503 in front of the approving technician (#6200). Add ' +
        'each to USER_OWNED_RELEASE_ACTIONS in jobs/intentReleaseWorker.ts — with its own release ' +
        "test and an approverReleaseMismatch() guard in the branch — or make it agent-unreachable:\n" +
        `${JSON.stringify(missing, null, 2)}`,
    ).toEqual([]);
  });

  it('every allowlisted fleet action still guards on approverRelease in its branch', () => {
    // The worker hands the approver's id to the handler in the context bag.
    // A branch that writes the FK without comparing the two would silently
    // accept a disagreement about who owns the row it creates — the one thing
    // it must never get wrong (the log_time_entry precedent in
    // aiToolsTicketing.ts).
    const fleetTools = new Set(sites.map((s) => s.tool));
    const unguarded: string[] = [];
    for (const key of allowlist) {
      const [tool, action] = key.split(':') as [string, string];
      if (!fleetTools.has(tool)) continue; // lives in another tool module
      const site = sites.find((s) => s.tool === tool && s.actions.includes(action));
      if (!site) continue;
      // Search the branch, from its `if (action === ...)` guard down to the
      // write, for the shared mismatch check.
      const lines = FLEET_SRC.split('\n');
      let branchStart = 0;
      for (let j = site.line - 1; j >= 0; j--) {
        if (/action\s*===\s*'/.test(lines[j]!)) { branchStart = j; break; }
      }
      const branch = lines.slice(branchStart, site.line).join('\n');
      if (!branch.includes('approverReleaseMismatch')) unguarded.push(key);
    }
    expect(
      unguarded,
      'These allowlisted fleet branches write a users FK without an approverReleaseMismatch(auth, context) ' +
        `check between the action guard and the write:\n${JSON.stringify(unguarded, null, 2)}`,
    ).toEqual([]);
  });

  it('every tier-2 users-FK write refuses an ai_agent principal before the write (#6206)', () => {
    // A tier-2 action auto-executes inline under the agent's own auth — there
    // is no approval and so no approver to own the row, which is why
    // `USER_OWNED_RELEASE_ACTIONS` (the #6200 fix) cannot reach these sites.
    // They carry the SAME latent 23503, so each one must instead refuse an
    // agent principal BEFORE the write: `isAgentPrincipalCaller(auth)` ->
    // `refuseFleetAgentPrincipal(action)` (#6206). Catching the 23503 is not
    // an option — inside `withDbAccessContext` it aborts the surrounding
    // transaction and surfaces as a 500.
    //
    // This is a contract, not an inventory: it fails when a NEW tier-2
    // users-FK write lands without a guard, and it fails when an existing
    // guard is deleted.
    // Scope is every action that is NOT tier 3 — i.e. everything that
    // auto-executes inline. Membership of `TIER2_ACTIONS` is deliberately NOT
    // the test: an action absent from every tier map falls back to its tool's
    // base tier in `resolveGuardrailCheck`, which for these tools is 1 —
    // auto-executing just the same. Keying off `TIER2_ACTIONS` would give this
    // contract the same blind spot as the code it guards.
    const exposed: string[] = [];
    const guarded: string[] = [];
    for (const site of sites) {
      if (!usersFk.has(site.property)) continue;
      for (const action of site.actions) {
        const key = `${site.tool}:${action}`;
        if (tier3.has(key)) continue; // governed by USER_OWNED_RELEASE_ACTIONS above
        if (!zodActions(site.tool).includes(action)) continue;
        // Accepted by the validator but hard-refused before the write; proven
        // against the source by its own `it`.
        if (AGENT_UNREACHABLE.has(key)) continue;
        if (hasAgentPrincipalRefusalBefore(site.tool, action, site.line)) {
          guarded.push(`${key}@${site.line}`);
          continue;
        }
        exposed.push(`${key} writes ${site.property} (users FK) at aiToolsFleet.ts:${site.line}`);
      }
    }

    // Anti-vacuity: the six known sites must still be FOUND and guarded, so a
    // parse regression cannot turn this into an empty-set pass.
    expect(
      [...new Set(guarded.map((g) => g.split('@')[0]!))].sort(),
      'the known #6206 auto-executing users-FK sites are no longer being found — the scan or the source moved',
    ).toEqual([
      'generate_report:create',
      'generate_report:generate',
      'manage_patches:approve',
      'manage_patches:bulk_approve',
      'manage_patches:decline',
      'manage_patches:defer',
    ]);

    expect(
      exposed,
      'These fleet branches store auth.user.id in a users FK and are TIER 2 — they auto-execute ' +
        'inline under an agent principal, where that id is an aiAgents.id, so the insert is a ' +
        '23503 (#6206). There is no approver to substitute; add an ' +
        'isAgentPrincipalCaller(auth) -> refuseFleetAgentPrincipal(action) refusal before the ' +
        `write, or give the action a real agent-owned identity:\n${JSON.stringify(exposed, null, 2)}`,
    ).toEqual([]);
  });
});
