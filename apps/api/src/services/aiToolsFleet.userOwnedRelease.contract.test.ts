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
 *   3. the action is actually reachable — present in the tool's own
 *      `input_schema` `action` enum. Several branches in this file are
 *      defense-in-depth behind a disabled-action gate and are excluded from
 *      the enum, so an agent cannot invoke them at all.
 */
const API_SRC = fileURLToPath(new URL('..', import.meta.url));

const FLEET_SRC = readFileSync(join(API_SRC, 'services/aiToolsFleet.ts'), 'utf8');
const GUARDRAILS_SRC = readFileSync(join(API_SRC, 'services/aiGuardrails.ts'), 'utf8');
const WORKER_SRC = readFileSync(join(API_SRC, 'jobs/intentReleaseWorker.ts'), 'utf8');

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
  /** The tool's own input_schema action enum — empty if it has none. */
  schemaActions: string[];
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
  const enums: string[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const enumMatch = /action:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]*)\]/.exec(line);
    if (enumMatch) enums.push([...enumMatch[1]!.matchAll(/'([^']+)'/g)].map((a) => a[1]!));

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
      sites.push({
        line: i + 1,
        property: write[1]!,
        tool,
        actions,
        schemaActions: enums.at(-1) ?? [],
      });
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
  });

  it('every agent-mintable, reachable users-FK write is in USER_OWNED_RELEASE_ACTIONS', () => {
    const missing: string[] = [];
    for (const site of sites) {
      if (!usersFk.has(site.property)) continue;
      for (const action of site.actions) {
        const key = `${site.tool}:${action}`;
        if (!tier3.has(key)) continue; // tier 1/2 — never mints an intent
        // Unreachable: excluded from the tool's own action enum (a
        // defense-in-depth branch behind a disabled-action gate).
        if (site.schemaActions.length > 0 && !site.schemaActions.includes(action)) continue;
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

  it('documents the tier-2 users-FK writes that cannot be fixed by this allowlist', () => {
    // A tier-2 action auto-executes inline under the agent's own auth — there
    // is no approval and so no approver to own the row. Those sites carry the
    // SAME latent 23503 but need a different fix (a nullable/system
    // attribution, or lifting the action to tier 3), tracked separately.
    // This assertion is an INVENTORY, not an exemption: it fails when the set
    // changes, so a new tier-2 users-FK write cannot land unnoticed.
    const tier2Exposed = new Set<string>();
    const tier2Body = GUARDRAILS_SRC.slice(
      GUARDRAILS_SRC.indexOf('const TIER2_ACTIONS'),
      GUARDRAILS_SRC.indexOf('\n};', GUARDRAILS_SRC.indexOf('const TIER2_ACTIONS')),
    );
    const tier2 = new Set<string>();
    for (const m of tier2Body.matchAll(/^\s{2}(\w+)\s*:\s*\[([^\]]*)\]/gm)) {
      for (const a of m[2]!.matchAll(/'([^']+)'/g)) tier2.add(`${m[1]}:${a[1]}`);
    }
    for (const site of sites) {
      if (!usersFk.has(site.property)) continue;
      for (const action of site.actions) {
        const key = `${site.tool}:${action}`;
        if (!tier2.has(key)) continue;
        if (site.schemaActions.length > 0 && !site.schemaActions.includes(action)) continue;
        tier2Exposed.add(key);
      }
    }
    expect([...tier2Exposed].sort()).toEqual([
      'generate_report:create',
      'generate_report:generate',
      'manage_patches:approve',
      'manage_patches:bulk_approve',
      'manage_patches:decline',
      'manage_patches:defer',
    ]);
  });
});
