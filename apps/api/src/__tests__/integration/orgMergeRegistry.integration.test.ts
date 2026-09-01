import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { getOrgMergePolicies, __testOnly } from '../../services/orgMergeRegistry';
import { buildRepointDedupe } from '../../services/orgMergeExecutors';
import {
  CUSTOM_EXECUTORS,
  CUSTOM_RESOLVE_EXECUTORS,
  CUSTOM_WOULD_DROP_COUNTS,
} from '../../services/orgMergeCustomExecutors';

const EXTRA_REQUIRED = [
  // no org_id, but a merge must account for them (follows-parent/derived).
  // software_deployments is NOT here: it has its own org_id column and is
  // already in getOrgCascadeDeleteOrder() (see orgMergeRegistry.ts's
  // SPECIAL comment for why it's classified plain repoint, not
  // follows-parent).
  'device_commands', 'user_sso_identities', 'sso_sessions', 'psa_ticket_mappings',
  'deployment_results', 'software_versions',
  // P2-3 (#4190): report_runs joined ASSOCIATED_SYSTEM_SCOPED_TABLES when the
  // org-erasure FK gap on reports.report_id was closed. Parent-keyed, so it
  // travels with its definition's repointed org_id.
  'report_runs',
  'partner_export_configuration_org_state', 'partner_export_device_material_state',
  'partner_export_site_material_state',
];

// --- SQL comparison helpers for the correctness tests below -----------------
//
// These compare the registry's declarative `key` / `keyWhere` strings against
// the real unique index Postgres reports via pg_indexes.indexdef. Postgres's
// deparser rewrites expressions in ways that don't change meaning but do
// change surface syntax — it adds explicit type casts (`(name)::text`),
// rewrites `col IN (a, b, c)` as `col = ANY (ARRAY[a, b, c])`, and wraps
// predicates/sub-expressions in extra parens — so both sides are normalized
// before comparing rather than compared as raw strings.

/** Finds the index of the ')' that matches the '(' at `openIdx`. */
function matchParen(s: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced parens: ${s}`);
}

/** Splits a comma-separated list at the top level only (commas nested inside parens don't split). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

/** Parses a `pg_indexes.indexdef` string into its column-list text and optional WHERE-predicate text. */
function parseIndexDef(indexdef: string): { columnsText: string; whereText: string | null } {
  const usingMatch = indexdef.match(/USING \w+ \(/);
  if (!usingMatch || usingMatch.index === undefined) {
    throw new Error(`unexpected indexdef shape: ${indexdef}`);
  }
  const openIdx = usingMatch.index + usingMatch[0].length - 1;
  const closeIdx = matchParen(indexdef, openIdx);
  const columnsText = indexdef.slice(openIdx + 1, closeIdx);
  const rest = indexdef.slice(closeIdx + 1).trim();
  const whereMatch = rest.match(/^WHERE\s+(.*)$/i);
  return { columnsText, whereText: whereMatch?.[1] ?? null };
}

/** Strips the `{col}` placeholder braces the registry uses around column references inside expressions. */
function stripPlaceholders(s: string): string {
  return s.replace(/[{}]/g, '');
}

/**
 * Normalizes a SQL column/expression or predicate fragment for loose
 * comparison against pg_get_indexdef's rendering:
 *  - `col = ANY (ARRAY[a, b, c])` -> `col IN (a,b,c)` (Postgres's rewrite of `IN`)
 *  - drops explicit type casts (`::text`, `::uuid`, ...) the deparser adds
 *  - collapses a cast-artifact paren-wrap, `((x))` -> `(x)`
 *  - drops all whitespace and lowercases
 * None of these change SQL meaning, only surface syntax.
 */
function normalizeSql(raw: string): string {
  let s = raw;
  s = s.replace(/(\w+)\s*=\s*ANY\s*\(\s*ARRAY\[([^\]]*)\]\s*\)/gi, (_m, col: string, list: string) => {
    const items = splitTopLevel(list).map((x) => x.trim());
    return `${col} IN (${items.join(',')})`;
  });
  s = s.replace(/::"?[a-zA-Z_][a-zA-Z0-9_ ]*"?(\([^)]*\))?/g, '');
  s = s.replace(/\(\(([a-zA-Z_][a-zA-Z0-9_]*)\)\)/g, '($1)');
  s = s.replace(/\s+/g, '');
  return s.toLowerCase();
}

/** Repeatedly strips one fully-enclosing paren pair, e.g. `((x))` -> `x`. */
function stripOuterParens(s: string): string {
  while (s.length >= 2 && s[0] === '(' && s[s.length - 1] === ')' && matchParen(s, 0) === s.length - 1) {
    s = s.slice(1, -1);
  }
  return s;
}

/**
 * True if a normalized column token IS or REFERENCES the org-scoping column
 * — either bare `org_id`, or an expression wrapping it (e.g.
 * `COALESCE(org_id, <nil-uuid>)`, the partner-wide-first pattern used by
 * playbook_definitions). None of the registry's declared key columns ever
 * reference org_id themselves, so a plain substring check is safe.
 */
function isOrgScopingToken(normalizedToken: string): boolean {
  return normalizedToken === 'org_id' || normalizedToken.includes('org_id');
}

interface ParsedUniqueIndex {
  indexname: string;
  nonOrgColumns: Set<string>;
  whereNormalized: string | null; // null = no partial predicate
}

async function getUniqueIndexes(table: string): Promise<ParsedUniqueIndex[]> {
  const rows = (await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = ${table} AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
  `)) as unknown as { indexname: string; indexdef: string }[];
  return rows.map((r) => {
    const { columnsText, whereText } = parseIndexDef(r.indexdef);
    const tokens = splitTopLevel(columnsText).map(normalizeSql);
    const nonOrgColumns = new Set(tokens.filter((t) => !isOrgScopingToken(t)));
    const whereNormalized = whereText ? stripOuterParens(normalizeSql(whereText)) : null;
    return { indexname: r.indexname, nonOrgColumns, whereNormalized };
  });
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

function isSubset(small: Set<string>, big: Set<string>): boolean {
  return [...small].every((x) => big.has(x));
}

// remediation_suggestions declares a deliberately looser key
// (['source_type','source_id']) than any single real constraint: the DB
// enforces FOUR mutually-exclusive partial uniques, each adding one more
// differentiating column (script_id / script_template_id / playbook_id /
// target_type) under a different `WHERE target_type = '...'`. The registry
// documents over-dropping as safe (derived rows), so this table is checked
// as a column SUPERSET match against any one of the four, with no predicate
// comparison (there's no single predicate to compare against — each of the
// four has a different one).
const KEY_SUPERSET_EXCEPTIONS = new Set(['remediation_suggestions']);

// tenant_variables' real partial index carries `WHERE org_id IS NOT NULL`,
// which the registry's key deliberately omits: every row a merge ever
// touches for this table already has org_id set (that's how it got scoped
// to the org being merged), so the predicate is trivially satisfied and
// doesn't need to be replicated in keyWhere. Column-set matching still runs
// for this table below — only the predicate-equality check is skipped.
const PREDICATE_CHECK_EXCEPTIONS = new Set(['tenant_variables']);

/**
 * Every BEFORE UPDATE row trigger living on a table that has an `org_id`
 * column, split by whether it stops the merge's `UPDATE ... SET org_id`.
 * Bodies read on a live database; the contract test below fails on anything
 * present in neither map, so a trigger arriving from main has to be reviewed
 * rather than guessed at.
 *
 * BLOCKING = the repoint cannot happen. Either the trigger RAISEs, or it
 * silently writes the old value back — equally fatal, and quieter.
 */
const ORG_ID_BLOCKING_TRIGGERS: Readonly<Record<string, string>> = {
  // Conditional immutability guards: RAISE iff org_id changed.
  'action_intents.action_intents_immutable_trg': 'RAISEs iff org_id changed',
  'ai_agent_runs.ai_agent_runs_immutable_trg': 'RAISEs iff org_id changed',
  // Unconditional append-only guards: RAISE on any UPDATE (the retention job's
  // `breeze.allow_audit_retention` GUC is the only bypass, and it is DELETE-path
  // machinery, not something a merge may set).
  'audit_logs.audit_log_block_update': 'unconditional append-only RAISE',
  'audit_log_chain.audit_log_chain_block_update': 'unconditional append-only RAISE',
  'audit_chain_anchors.audit_chain_anchor_block_update': 'unconditional append-only RAISE',
  'ml_feedback_events.ml_feedback_events_block_update': 'unconditional append-only RAISE',
  // Silent revert: `NEW.org_id := OLD.org_id` on every direct UPDATE. Scoped
  // to `WHEN (pg_trigger_depth() = 0)`, so the ON UPDATE CASCADE from
  // devices/sites still flows through — which is exactly why these two are
  // `derived` and the engine must never write them itself.
  'partner_export_device_material_state.breeze_partner_export_guard_direct_write': 'silent org_id revert at depth 0',
  'partner_export_site_material_state.breeze_partner_export_guard_direct_write': 'silent org_id revert at depth 0',
  // PAM actuations: hardened to RAISE 42501 iff org_id changed (Track E
  // §Hardening, apps/api/migrations/2026-09-25-pam-actuation-org-immutable.sql).
  // Generation-decrease and cleanup-tombstone checks are unrelated to org_id
  // and fire regardless.
  'pam_actuations.pam_actuations_transition_guard':
    'RAISEs 42501 iff org_id changed (apps/api/migrations/2026-09-25-pam-actuation-org-immutable.sql); generation/tombstone checks otherwise',
  // PAM actuation results: unconditional append-only RAISE (42501) on UPDATE
  // — no bypass exists for any app role.
  'pam_actuation_results.pam_actuation_results_block_mutation':
    'unconditional append-only RAISE (42501) on UPDATE — no bypass exists for any app role',
};

/** BENIGN = fires on the repoint but does not obstruct it. Reason per entry. */
const ORG_ID_BENIGN_TRIGGERS: Readonly<Record<string, string>> = {
  // Validates NEW.org_id against backup_configs(storage_config_id) and raises
  // 23503 on a mismatch. It constrains the ORDER of the walk, not the write:
  // c2c_backup_configs.storage_config_id -> backup_configs(id) is a real FK, so
  // the parents-first topological walk repoints backup_configs first and the
  // check passes. If that FK ever goes away, this moves to BLOCKING.
  'c2c_backup_configs.c2c_storage_config_org_guard':
    'cross-table org-match check; satisfied by parents-first ordering via a real FK to backup_configs',
  // Partner-export watermark freezes — they pin partner_export_updated_at, and
  // touch no other column.
  'devices.breeze_partner_export_guard_devices_watermark': 'partner-export watermark freeze',
  'sites.breeze_partner_export_guard_sites_watermark': 'partner-export watermark freeze',
  'device_hardware.breeze_partner_export_guard_hardware_watermark': 'partner-export watermark freeze',
  // Append-only evidence guards that explicitly admit an org_id-only
  // restamp after the authoritative device row has moved. All evidence
  // fields remain byte-for-byte unchanged.
  'agent_rollback_events.agent_rollback_events_block_update': 'org_id-only device-owner restamp',
  'peripheral_policy_delivery_events.peripheral_policy_delivery_events_block_update': 'org_id-only device-owner restamp',
  // Track B durable evidence: both immutability guards deliberately omit
  // org_id from their compared set so the device move / merge repoint
  // contract can restamp tenancy; every evidence field stays immutable.
  'agent_health_observations.agent_health_observations_immutable_trg': 'org_id-only device-owner restamp',
  'software_inventory_observations.software_inventory_observations_immutable_trg': 'org_id-only device-owner restamp',
  // Plain updated_at bumps.
  'elevation_requests.trg_elevation_requests_updated_at': 'updated_at bump',
  'incidents.trg_incidents_updated_at': 'updated_at bump',
  'ticket_parts.trg_ticket_parts_updated_at': 'updated_at bump',
  'time_entries.trg_time_entries_updated_at': 'updated_at bump',
  // NOTE: the three `config_policy_*_tenant_integrity` triggers (org lifecycle
  // wave 2, #4074) used to be classified here as benign cross-table org-match
  // checks satisfied by the parents-first repoint walk. They no longer exist:
  // migrations 2026-08-01-b (backup) and 2026-08-01-c (onedrive) DROP them and
  // replace the tenant-integrity guarantee with reference serialization. The
  // entries are removed rather than kept "just in case" — a map entry for a
  // trigger that isn't there covers nothing. If a future migration reinstates
  // any of them, the unreviewed-trigger check below fails and forces a fresh
  // classification, which is the direction this contract is meant to run in.
};

/**
 * BLOCKING in isolation, but unreachable during a merge: a `blocks-merge`
 * policy refuses the merge before the guarded write can run. The discharge
 * assertion keeps this honest — weaken the named policy and this
 * classification reds with it.
 */
const ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS: Readonly<
  Record<string, { dischargedBy: string; requiredPolicyKind: 'blocks-merge'; note: string }>
> = {
  'devices.devices_pam_history_move_guard': {
    dischargedBy: 'pam_actuations',
    requiredPolicyKind: 'blocks-merge',
    note: 'RAISEs 23514 on any devices.org_id change while the device has a pam_actuations row; a loser org with such rows is refused by the blocks-merge policy before the devices repoint',
  },
};

/**
 * Extracts the table name from a `table.trigger` map key (the format all
 * three trigger-classification maps above are keyed in). A plain
 * `key.split('.')[0]` types as `string | undefined` under this repo's
 * `noUncheckedIndexedAccess`, even though every key here is guaranteed to
 * contain a dot — this stays type-sound without asserting past the
 * compiler, and throws loudly (rather than silently matching nothing) if
 * that guarantee is ever violated.
 */
function tableOf(key: string): string {
  const dot = key.indexOf('.');
  if (dot === -1) throw new Error(`trigger-classification map key missing '.' separator: ${key}`);
  return key.slice(0, dot);
}

describe('Org merge policy registry contract', () => {
  const policies = getOrgMergePolicies();
  const required = new Set([...getOrgCascadeDeleteOrder(), ...EXTRA_REQUIRED]);

  it('every required table has exactly one policy', () => {
    const missing = [...required].filter(t => !policies.has(t));
    expect(missing).toEqual([]);
  });

  it('no policy names an unrequired table', () => {
    const extra = [...policies.keys()].filter(t => !required.has(t));
    expect(extra).toEqual([]);
  });

  it('organizations is loser-shell; the four append-only tables are leave-for-erasure', () => {
    expect(policies.get('organizations')).toEqual({ kind: 'loser-shell' });
    for (const t of ['audit_logs', 'audit_log_chain', 'audit_chain_anchors', 'ml_feedback_events']) {
      expect(policies.get(t)?.kind, t).toBe('leave-for-erasure');
    }
  });

  it('repoints Track D device-control state and evidence with the device owner', () => {
    for (const table of [
      'agent_rollback_directives',
      'agent_rollback_events',
      'peripheral_policy_delivery_events',
      'peripheral_policy_device_states',
    ]) {
      expect(policies.get(table), table).toEqual({ kind: 'repoint' });
    }
  });

  it('SPECIAL and REPOINT_TABLES are disjoint (no table classified twice)', () => {
    // getOrgMergePolicies() itself throws on a collision (see
    // orgMergeRegistry.ts), so this would already fail loudly at the
    // `getOrgMergePolicies()` call above — this assertion exists to give a
    // precise, named failure (which tables collided) instead of a bare
    // thrown error.
    const specialKeys = Object.keys(__testOnly.SPECIAL);
    const overlap = specialKeys.filter((t) => __testOnly.REPOINT_TABLES.includes(t));
    expect(overlap).toEqual([]);
  });

  it('every repoint-dedupe key column exists on its table', async () => {
    for (const [table, policy] of policies) {
      if (policy.kind !== 'repoint-dedupe') continue;
      for (const col of policy.key) {
        if (col.includes('(')) continue; // expression keys (e.g. lower(name)) checked below
        const r = await db.execute(sql`
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${col}`);
        expect((r as unknown as unknown[]).length, `${table}.${col}`).toBe(1);
      }
    }
  });

  it('every keep-survivor table has a UNIQUE constraint on exactly (org_id)', async () => {
    for (const [table, policy] of policies) {
      if (policy.kind !== 'keep-survivor') continue;
      const indexes = await getUniqueIndexes(table);
      const match = indexes.find((ix) => ix.whereNormalized === null && ix.nonOrgColumns.size === 0);
      expect(
        match,
        `${table}: expected a total (non-partial) UNIQUE index on exactly (org_id); found unique indexes: ${JSON.stringify(indexes.map((i) => i.indexname))}`,
      ).toBeDefined();
    }
  });

  /**
   * Executor coverage for the `custom` kind, in the fast-failing direction.
   *
   * `runPolicy` already throws at RUNTIME for a `custom` table with no
   * executor — but only when the walk reaches that table, mid-merge, with the
   * loser org already fenced and drained. Catching it here instead is the
   * difference between a red test and a production merge that dies halfway.
   */
  it('every custom table has a move executor, and every resolve half has a move half', () => {
    const customTables = [...policies].filter(([, p]) => p.kind === 'custom').map(([t]) => t);
    expect(customTables.length).toBeGreaterThan(0);

    const missingExecutor = customTables.filter((t) => !CUSTOM_EXECUTORS[t]);
    expect(missingExecutor, 'custom tables with no entry in CUSTOM_EXECUTORS').toEqual([]);

    // A resolve half without a move half would resolve the collisions and then
    // leave every surviving row stranded under the dead loser org.
    const orphanResolvers = Object.keys(CUSTOM_RESOLVE_EXECUTORS)
      .filter((t) => !CUSTOM_EXECUTORS[t] || policies.get(t)?.kind !== 'custom');
    expect(orphanResolvers, 'CUSTOM_RESOLVE_EXECUTORS keys that are not custom tables with a move half').toEqual([]);

    // And nothing may claim a would-drop mirror it cannot back with a policy.
    const orphanCounters = Object.keys(CUSTOM_WOULD_DROP_COUNTS)
      .filter((t) => policies.get(t)?.kind !== 'custom');
    expect(orphanCounters, 'CUSTOM_WOULD_DROP_COUNTS keys that are not custom tables').toEqual([]);
  });

  /**
   * THE guard this whole fix wave exists to make permanent.
   *
   * `repoint-dedupe` and `keep-survivor` both resolve a collision by DELETEing
   * the loser's row. That is only safe when nothing REFERENCES that row with an
   * FK Postgres will refuse to break. `ON DELETE CASCADE` and `SET NULL` are
   * fine (the reference resolves itself); `NO ACTION` and `RESTRICT` are not —
   * they raise 23503 and abort the entire merge transaction, after the fence,
   * the drain and however much of the walk had already run.
   *
   * Deferrability does NOT rescue a NO ACTION here, which is the trap: Phase B
   * runs `SET CONSTRAINTS ALL DEFERRED`, so it is tempting to assume the check
   * is postponed harmlessly. It is postponed to COMMIT, where the child row is
   * still pointing at a row that no longer exists — same 23503, later. So this
   * asserts on the delete ACTION alone and ignores deferrability entirely.
   *
   * Five tables failed this when it was first written (discovered_assets,
   * plugin_installations, playbook_definitions, incidents, pam_signer_groups);
   * all five are now `custom` and re-home or neutralize instead. A sixth
   * arriving as a plain `repoint-dedupe` is a latent merge-aborting bug that no
   * amount of code review has ever caught, so it fails here instead.
   */
  it('no repoint-dedupe / keep-survivor table has an inbound FK that would block its DELETE', async () => {
    const deleters = [...policies]
      .filter(([, p]) => p.kind === 'repoint-dedupe' || p.kind === 'keep-survivor')
      .map(([t]) => t);
    expect(deleters.length).toBeGreaterThan(20);

    const rows = (await db.execute(sql`
      SELECT parent.relname AS parent_table,
             child.relname  AS child_table,
             c.conname      AS constraint_name,
             CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' ELSE 'RESTRICT' END AS on_delete
        FROM pg_constraint c
        JOIN pg_class parent ON parent.oid = c.confrelid
        JOIN pg_class child  ON child.oid  = c.conrelid
       WHERE c.contype = 'f'
         AND c.confdeltype IN ('a', 'r')
         AND parent.relname = ANY(${sql.raw(`ARRAY[${deleters.map((t) => `'${t}'`).join(',')}]::text[]`)})
       ORDER BY 1, 2, 3`)) as unknown as Array<{
      parent_table: string;
      child_table: string;
      constraint_name: string;
      on_delete: string;
    }>;

    expect(
      rows.map((r) => `${r.parent_table} <- ${r.child_table}.${r.constraint_name} (${r.on_delete})`),
      'these tables\' dedupe DELETE will raise 23503 and abort the whole merge — reclassify them `custom` and re-home the children first (see orgMergeCustomExecutors.ts rehomeChildrenThenDelete)',
    ).toEqual([]);
  });

  /**
   * The sibling of the FK guard above, for the other way a policy can be
   * physically impossible rather than merely wrong.
   *
   * `repoint`, `repoint-dedupe`, `keep-survivor` and every `custom` executor
   * finish by UPDATEing `org_id`. A BEFORE UPDATE row trigger that RAISEs when
   * `org_id` changes makes that statement unrunnable — and unlike a constraint,
   * a trigger has no deferral and no bypass the merge can reach:
   * `ALTER TABLE ... DISABLE TRIGGER` needs table ownership and
   * `session_replication_role = 'replica'` needs superuser, while the merge
   * runs as the unprivileged `breeze_app`. The only correct classification for
   * such a table is one that never writes `org_id` at all.
   *
   * Two tables failed this when it was written. `ai_agent_runs` arrived
   * unclassified with main's AI-agents work. `action_intents` was worse: it had
   * been `repoint-dedupe` since Wave 2, keyed on a correctly-read unique index,
   * while `action_intents_block_content_update()` had listed `org_id` in its
   * immutable set since 2026-07-18 — so any merge of an org holding a single
   * action intent would have died with `action_intents content is immutable`
   * after the fence and the drain. The gauntlet missed it for the usual reason
   * a gauntlet misses things: its fixture creates no rows in that table.
   *
   * Detection is deliberately narrow — a NEW-vs-OLD `org_id` comparison in a
   * function that RAISEs. That is the shape all three known immutability guards
   * use, and it excludes validators that merely read `NEW.org_id` to check it
   * against a parent row (`c2c_backup_configs`' storage-config org-match
   * guard), which constrain the ORDER of the walk rather than forbidding the
   * write.
   */
  it('no org_id-mutating policy sits on a table whose org_id a trigger blocks', async () => {
    // Kinds that never issue an `UPDATE ... SET org_id`. Everything else does,
    // `custom` included — every custom executor ends in buildRepoint().
    const NON_MUTATING = new Set(['leave-for-erasure', 'derived', 'follows-parent', 'loser-shell', 'blocks-merge']);

    const rows = (await db.execute(sql`
      SELECT c.relname AS table_name, t.tgname AS trigger_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       WHERE NOT t.tgisinternal
         AND (t.tgtype & 2)  <> 0   -- BEFORE
         AND (t.tgtype & 16) <> 0   -- UPDATE
         AND (t.tgtype & 1)  <> 0   -- FOR EACH ROW
         AND EXISTS (
           SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
         )
       ORDER BY 1, 2`)) as unknown as Array<{ table_name: string; trigger_name: string }>;

    // Vacuity guard: the enumeration must actually find things. A bitmask slip
    // or a schema filter typo would otherwise make every assertion below pass
    // over an empty list.
    expect(rows.length).toBeGreaterThanOrEqual(10);

    // Anything discovered but unreviewed fails here FIRST, so a new BEFORE
    // UPDATE trigger arriving from main forces a decision instead of silently
    // landing in whichever bucket a heuristic guessed.
    const unreviewed = rows
      .filter((r) => {
        const key = `${r.table_name}.${r.trigger_name}`;
        return (
          !(key in ORG_ID_BLOCKING_TRIGGERS) &&
          !(key in ORG_ID_BENIGN_TRIGGERS) &&
          !(key in ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS)
        );
      })
      .map((r) => `${r.table_name}.${r.trigger_name}`);
    expect(
      unreviewed,
      'new BEFORE UPDATE row trigger(s) on an org_id table — read each body and add it to ORG_ID_BLOCKING_TRIGGERS (it RAISEs on, or silently reverts, an org_id change), ORG_ID_BENIGN_TRIGGERS (with the reason it does not stop a repoint), or ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS (blocking in isolation, but discharged by a live blocks-merge policy)',
    ).toEqual([]);

    // A map entry whose trigger no longer exists is WARNED about, not failed.
    // The contract only runs one way: an unclassified LIVE trigger is a real
    // hazard (the merge would abort mid-walk), while a leftover entry is
    // merely untidy — it classifies nothing and blocks nothing.
    //
    // Failing on it made this suite environment-dependent, which is strictly
    // worse than untidy: whether migrations 2026-08-01-b/c (which DROP the
    // three config_policy_*_tenant_integrity triggers) have been applied to
    // the database under test decided the trigger inventory, so the same
    // commit passed or failed depending on the age of the local volume. A
    // contract test that reds on migration drift teaches people to distrust
    // it. Stale entries surface as a console.warn for the next reader to
    // prune; only a trigger nobody has classified stops the build.
    const live = new Set(rows.map((r) => `${r.table_name}.${r.trigger_name}`));
    const stale = [
      ...Object.keys(ORG_ID_BLOCKING_TRIGGERS),
      ...Object.keys(ORG_ID_BENIGN_TRIGGERS),
      ...Object.keys(ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS),
    ].filter((k) => !live.has(k));
    if (stale.length > 0) {
      console.warn(
        `[orgMergeRegistry] trigger classification entries with no live BEFORE UPDATE row trigger (safe to prune): ${stale.join(', ')}`,
      );
    }

    // discharged: see ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS — a
    // conditionally-blocking table's trigger is deliberately absent from
    // ORG_ID_BLOCKING_TRIGGERS above (it lives only in the third map), so it
    // never reaches this check. Its safety is asserted separately, by the
    // discharge test below.
    const blockingTables = [...new Set(Object.keys(ORG_ID_BLOCKING_TRIGGERS).map(tableOf))];
    const violations = blockingTables
      .filter((table) => {
        const kind = policies.get(table)?.kind;
        return kind !== undefined && !NON_MUTATING.has(kind);
      })
      .map((table) => {
        const entry = Object.entries(ORG_ID_BLOCKING_TRIGGERS).find(([key]) => key.startsWith(`${table}.`))!;
        return `${table} (${policies.get(table)?.kind}) blocked by ${entry[0]} (${entry[1]})`;
      });

    expect(
      violations,
      'these tables are classified with a policy that UPDATEs org_id, but a BEFORE UPDATE trigger stops an org_id change — the merge would abort (or silently no-op) mid-walk. Reclassify them `leave-for-erasure`: there is no bypass available to breeze_app',
    ).toEqual([]);
  });

  /**
   * A `repoint`/`repoint-dedupe` policy issues a direct
   * `UPDATE <table> SET org_id = survivor WHERE org_id = loser` as
   * `breeze_app` (buildRepoint / buildRepointDedupe, orgMergeExecutors.ts).
   * If `breeze_app` doesn't hold UPDATE on that table, the statement raises
   * 42501 the instant it runs — even against zero matching rows — aborting
   * the merge after the loser org has already been fenced off. Nothing else
   * in this suite catches that: this file connects as the schema owner (not
   * `breeze_app`), and the repoint-dedupe smoke test below runs inside a
   * rolled-back transaction against throwaway, non-existent org ids, so a
   * REVOKEd UPDATE never actually fires there either — it would only raise
   * against a table the loser org actually owns rows in, in a real merge.
   *
   * `agent_health_observations` and `software_inventory_observations` both
   * had `UPDATE, TRUNCATE` REVOKEd from `breeze_app` in their own append-
   * only-evidence migrations (2026-09-28-100000, 2026-09-28-100002) while
   * their org_id still moves — via the
   * `(device_id, org_id) -> devices(id, org_id) ON UPDATE CASCADE` FK. That
   * is the exact mechanism `partner_export_device_material_state` uses,
   * which is why THAT table is `derived` rather than `repoint`. This
   * assertion is what would have caught the same misclassification here
   * before commit.
   */
  it('every repoint / repoint-dedupe table grants breeze_app UPDATE', async () => {
    const mutating = [...policies]
      .filter(([, p]) => p.kind === 'repoint' || p.kind === 'repoint-dedupe')
      .map(([table]) => table);
    expect(mutating.length).toBeGreaterThan(0);

    const revoked: string[] = [];
    for (const table of mutating) {
      const [row] = (await db.execute(sql`
        SELECT has_table_privilege('breeze_app', ${table}, 'UPDATE') AS can_update
      `)) as unknown as Array<{ can_update: boolean }>;
      if (!row?.can_update) revoked.push(table);
    }

    expect(
      revoked,
      `these tables are classified 'repoint'/'repoint-dedupe' (a direct UPDATE ... SET org_id as breeze_app) but breeze_app has UPDATE revoked on them — the statement raises 42501 mid-merge, after the loser org is already fenced. Reclassify 'derived' if org_id instead moves via an ON UPDATE CASCADE FK from a repointed parent (see partner_export_device_material_state), or 'leave-for-erasure' if it never moves at all: ${revoked.join(', ')}`,
    ).toEqual([]);
  });

  it('every conditionally-blocking trigger is discharged by a live blocks-merge policy', () => {
    for (const [key, cfg] of Object.entries(ORG_ID_CONDITIONALLY_BLOCKING_TRIGGERS)) {
      expect(policies.get(cfg.dischargedBy)?.kind, `${key} dischargedBy ${cfg.dischargedBy}`).toBe(cfg.requiredPolicyKind);
    }
  });

  it('every repoint-dedupe key matches a real unique index (columns and partial predicate)', async () => {
    for (const [table, policy] of policies) {
      if (policy.kind !== 'repoint-dedupe') continue;
      const declaredKey = new Set(policy.key.map((k) => normalizeSql(stripPlaceholders(k))));
      const declaredWhere = policy.keyWhere ? stripOuterParens(normalizeSql(stripPlaceholders(policy.keyWhere))) : null;
      const indexes = await getUniqueIndexes(table);

      if (KEY_SUPERSET_EXCEPTIONS.has(table)) {
        const match = indexes.find((ix) => isSubset(declaredKey, ix.nonOrgColumns));
        expect(
          match,
          `${table}: expected a unique index whose columns are a SUPERSET of org_id + ${JSON.stringify([...declaredKey])}; found ${JSON.stringify(indexes.map((i) => i.indexname))}`,
        ).toBeDefined();
        continue;
      }

      const columnMatch = indexes.find((ix) => setsEqual(ix.nonOrgColumns, declaredKey));
      expect(
        columnMatch,
        `${table}: expected a unique index on org_id + ${JSON.stringify([...declaredKey])}; found unique indexes: ${JSON.stringify(indexes.map((i) => i.indexname))}`,
      ).toBeDefined();

      if (columnMatch && !PREDICATE_CHECK_EXCEPTIONS.has(table)) {
        expect(columnMatch.whereNormalized, `${table}: keyWhere doesn't match the real partial predicate on ${columnMatch.indexname}`).toBe(declaredWhere);
      }
    }
  });
});

// --- Task 2 smoke test: every repoint-dedupe builder executes against real
// Postgres -----------------------------------------------------------------
//
// The compiled-SQL unit tests (orgMergeExecutors.test.ts) pin the exact text
// PgDialect().sqlToQuery() emits, but "compiles to the right string" isn't
// the same as "runs" — a syntactically-plausible string can still be invalid
// SQL (wrong parenthesization, an identifier Postgres rejects, etc.). This
// executes the DELETE+UPDATE pair every real `repoint-dedupe` registry entry
// builds, against two throwaway (non-existent) org ids, inside a transaction
// that's always rolled back — no seeded rows are needed because with no rows
// matching either loser id, both statements affect zero rows; the point is
// only to prove each statement is syntactically valid against the table's
// real schema and exercises every real key/keyWhere literal, including the
// expression-key forms (`lower({name})`, the tunnel_allowlists COALESCE key)
// and the keyWhere forms. Real Postgres is the arbiter
// here, matching the "compiled-SQL asserts have been wrong before" caveat in
// the task brief.
describe('Org merge repoint-dedupe executors run against real Postgres', () => {
  it('every repoint-dedupe policy statement executes cleanly (rolled back, no rows persist)', async () => {
    const policies = getOrgMergePolicies();
    const dedupeEntries = [...policies].filter(([, policy]) => policy.kind === 'repoint-dedupe');
    // Sanity: fail loudly if the registry somehow has zero repoint-dedupe
    // entries (a silent no-op smoke test proves nothing) rather than just
    // passing trivially.
    expect(dedupeEntries.length).toBeGreaterThan(0);

    const loserId = randomUUID();
    const survivorId = randomUUID();

    await expect(
      withSystemDbAccessContext(async () => {
        for (const [table, policy] of dedupeEntries) {
          if (policy.kind !== 'repoint-dedupe') continue; // narrow for TS
          // buildRepointDedupe returns `SQL[]` per its consumer contract (not
          // a fixed-length tuple), so under `noUncheckedIndexedAccess` a
          // plain destructure types each element as possibly `undefined`;
          // the builder's own contract guarantees exactly [delete, repoint].
          const [del, repoint] = buildRepointDedupe(table, policy.key, policy.keyWhere, loserId, survivorId) as [SQL, SQL];
          // postgres-js's execute() result is an array-like `Result` with a
          // non-enumerable `.count` carrying the real affected-row count
          // (its `.length` is always 0 here since neither statement uses
          // RETURNING) — see the sibling repoint below, which relies on the
          // same shape implicitly by not inspecting it at all.
          const delResult = (await db.execute(del)) as unknown as { count: number };
          expect(delResult.count, `${table}: expected zero rows deleted for throwaway org ids`).toBe(0);
          await db.execute(repoint);
        }
        throw new Error('org-merge-executors-smoke-rollback');
      })
    ).rejects.toThrow('org-merge-executors-smoke-rollback');
  });
});
