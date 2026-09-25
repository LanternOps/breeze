import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #6907 — the `USER_OWNED_RELEASE_ACTIONS` registration contract for the
 * `manage_alerts` tool (`services/aiToolsAlerts.ts`), the sibling of
 * `aiToolsFleet.userOwnedRelease.contract.test.ts` (#6200).
 *
 * Why a second contract: the fleet one decides "agent-mintable" from the
 * TIER-3 tables only, on the premise that tier 1/2 actions never mint an
 * intent. That premise is false for an agent principal — `intentService.ts`'s
 * `agentTier2` lane (P2-1) mints a Tier-2 `supervised` intent for any agent
 * call whose resolved tier is 2, and that is exactly how the alert-triage
 * agent's `manage_alerts:resolve` suggestions reach the release worker. All
 * three mutating alert actions write `auth.user.id` into a `users` FK, so
 * under the rebuilt agent auth every approved one was a guaranteed 23503
 * (`alerts.resolved_by`, US prod 2026-09-22 and 2026-09-24).
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
 * To cover another tool module, add it to MODULES — the scan is per-file.
 */
const API_SRC = fileURLToPath(new URL('..', import.meta.url));
const GUARDRAILS_SRC = readFileSync(join(API_SRC, 'services/aiGuardrails.ts'), 'utf8');
const WORKER_SRC = readFileSync(join(API_SRC, 'jobs/intentReleaseWorker.ts'), 'utf8');

const MODULES = ['services/aiToolsAlerts.ts'] as const;

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
 */
function writeSites(file: string): WriteSite[] {
  const lines = readFileSync(join(API_SRC, file), 'utf8').split('\n');
  const sites: WriteSite[] = [];
  let tool: string | null = null;
  let baseTier: number | null = null;
  let depth = 0;
  let guards: { depth: number; line: number; actions: string[] }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const tierDecl = /^\s*tier:\s*(\d)\s+as\s+AiToolTier/.exec(line);
    if (tierDecl) {
      baseTier = Number(tierDecl[1]);
      tool = null;
      depth = 0;
      guards = [];
    }
    const name = /^\s*name:\s*'([a-z0-9_]+)'/.exec(line);
    if (name && tool === null) tool = name[1]!;

    const write = /^\s*(\w+)\s*:\s*auth\.user\.id\s*,?\s*$/.exec(line);
    if (write && tool) {
      const actions = guards.length
        ? guards.map((g) => g.actions).reduce((acc, a) => acc.filter((x) => a.includes(x)))
        : [];
      const from = guards.length ? guards[guards.length - 1]!.line : i;
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

describe('agent-mintable users-FK writes are user-owned on release (#6907)', () => {
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
    // Every site resolved to a tool and at least one action guard.
    expect(qualifying.filter((s) => s.actions.length === 0)).toEqual([]);
  });

  it('every agent-mintable users-FK write is in USER_OWNED_RELEASE_ACTIONS', () => {
    const missing: string[] = [];
    for (const site of qualifying) {
      for (const action of site.actions) {
        if (!agentMintable(site.tool, action, site.baseTier)) continue;
        const key = `${site.tool}:${action}`;
        if (!allowlist.has(key)) missing.push(`${key} writes ${site.property} (users FK) at ${site.file}:${site.line}`);
      }
    }
    expect(
      [...new Set(missing)],
      'These tool branches store auth.user.id in a users FK and an agent can mint them as an action ' +
        'intent (tier 2 via the agentTier2 lane, or tier 3). Released under the rebuilt agent auth that id ' +
        'is an aiAgents.id, so the write is a guaranteed 23503 (#6200, #6907). Add each to ' +
        'USER_OWNED_RELEASE_ACTIONS in jobs/intentReleaseWorker.ts with its own release test and an ' +
        'approverReleaseMismatch() guard in the branch.',
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
