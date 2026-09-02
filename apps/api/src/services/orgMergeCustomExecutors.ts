/**
 * Hand-written org-merge executors (org-lifecycle Wave 2, Task 3).
 *
 * The registry (`orgMergeRegistry.ts`) classifies seventeen tables as `custom`.
 * Four were custom from the start (`contacts`, `backup_configs`,
 * `audit_baselines`, `pax8_orders`); ten were reclassified by review, in the
 * first three groups below; `ai_agents` arrived with main's AI-agents work and
 * hits both of the last two at once; `automation_resource_bindings` was added
 * when Track A met the exhaustive mainline registry; `ticket_drafts` (P2-4,
 * #4191) arrived later and is its own, fourth group. Each entry's registry note is
 * this file's spec — read them together.
 *
 *   - spec compliance: `api_keys` and `enrollment_keys` must be REVOKED rather
 *     than repointed (controller ruling R2), which no generic policy expresses;
 *   - the generic dedupe DELETE would have DESTROYED something — cascading
 *     children, per-org access scoping, or an incident's case file:
 *     `fleet_findings`, `organization_users`, `incidents`;
 *   - the generic dedupe DELETE would have ABORTED THE MERGE with 23503,
 *     because the row it removes has non-deferrable NO ACTION / RESTRICT
 *     children: `discovered_assets`, `plugin_installations`,
 *     `playbook_definitions`, `pam_signer_groups`, `reports`. These re-home
 *     their children onto the survivor's equivalent row and then delete the
 *     duplicate; see `rehomeChildrenThenDelete`.
 *   - no dedupe was ever involved — a SIBLING table's own plain `repoint`
 *     drags a composite FK out from under the row: `ticket_drafts` has
 *     `ticket_drafts_ticket_org_fk (ticket_id, org_id) -> tickets(id,
 *     org_id)`, and `tickets` repoints unconditionally, so any loser-org
 *     draft left in place disagrees with its own ticket's new org_id the
 *     instant `tickets` moves. The fix is an unconditional DELETE of every
 *     loser-org row, not a collision-keyed one — see `resolveTicketDrafts`.
 *
 * Contract, deliberately narrow so the engine stays uniform:
 *   - every executor runs inside the engine's ONE Phase-B transaction
 *     (`db` here is the ambient transaction proxy — never opens its own);
 *   - every executor leaves ZERO rows behind under the loser org;
 *   - `dropped` counts rows actually DELETEd, `moved` counts rows repointed,
 *     and `notes` carries anything an operator must see in the merge
 *     summary's `warnings` (demotions, deactivations, neutralizations and
 *     re-homings are not drops, but they are silent state changes, so they get
 *     surfaced);
 *   - executors run in the `move` phase unless they also appear in
 *     `CUSTOM_RESOLVE_EXECUTORS`, which is reserved for a table whose row
 *     must be gone BEFORE some other table's `move` half runs — a
 *     cascade-re-tenanted child racing its own parent's ON UPDATE CASCADE
 *     (`discovered_assets`, via `sites`), or a composite FK racing a
 *     SIBLING table's plain repoint (`ticket_drafts`, via `tickets`). Both
 *     reasons collapse to the same fix: run the DELETE in `resolve`, which
 *     completes for every table before `move` starts for any of them.
 *
 * NEVER add a DELETE to `contacts`, `backup_configs`, `audit_baselines`,
 * `fleet_findings`, `ai_agents` or `incidents`: their registry notes each
 * record the cascade, the credential material, the RESTRICT child or the case
 * file that a delete would take with it. `reports` deletes only the duplicate
 * DEFINITION, never a `report_runs` row — those are generated artifacts the
 * customer can download, so they are re-homed onto the surviving definition.
 */
import { sql, type SQL } from 'drizzle-orm';
import * as dbModule from '../db';
import { extractRowCount } from '../db/rowCount';
import { buildRepoint, keyExpr } from './orgMergeExecutors';

export interface MergeTableOutcome {
  moved: number;
  dropped: number;
  notes: string[];
}

export type CustomMergeExecutor = (loserOrgId: string, survivorOrgId: string) => Promise<MergeTableOutcome>;

async function run(statement: SQL): Promise<number> {
  return extractRowCount(await dbModule.db.execute(statement));
}

const uuid = (v: string) => sql`${v}::uuid`;

// ---------------------------------------------------------------------------
// Re-home-then-delete — the shared shape of the four executors that resolve a
// unique-key collision by DELETING the loser's duplicate.
//
// A dedupe DELETE is only safe when nothing references the row it removes.
// Four of the registry's former `repoint-dedupe` tables have inbound FKs that
// are neither CASCADE nor SET NULL, so the DELETE raises 23503 and aborts the
// WHOLE merge — and `SET CONSTRAINTS ALL DEFERRED` cannot save it, because none
// of those constraints is DEFERRABLE (verified against pg_constraint on a live
// database; the sweep is recorded in the task-8 report). The fix is uniform:
// point every child at the SURVIVOR's equivalent row first, then delete the
// now-unreferenced duplicate.
//
// The children are re-homed rather than deleted on purpose. `plugin_logs`,
// `playbook_executions` and the discovery children are history and live
// monitoring config; the survivor's row is the same thing under a different id,
// so following it forward loses nothing.
// ---------------------------------------------------------------------------

/** One inbound FK to re-point: `<table>.<column> -> <parent>.id`. */
interface ChildRef {
  table: string;
  column: string;
}

/**
 * Collision predicate between the survivor row (alias `s`) and the loser row
 * (alias `t`), built through the SAME `{col}` substitution the generic dedupe
 * builders use.
 *
 * Plain `=`, NOT the generic builder's `IS NOT DISTINCT FROM`. A btree unique
 * index treats NULLs as distinct, so two NULL-keyed rows never actually
 * collide; `IS NOT DISTINCT FROM` would call them a collision and delete a row
 * Postgres was perfectly happy to keep. Every key column used below is NOT NULL
 * anyway (`discovered_assets.ip_address`, `plugin_installations.catalog_id`,
 * `playbook_definitions.name`, `pam_signer_groups.name` — all verified), so
 * this is precision for the next table to join the list, not a behaviour change
 * for these four.
 */
function keyMatch(key: readonly string[]): SQL {
  return sql.join(key.map((k) => sql`${keyExpr(k, 's')} = ${keyExpr(k, 't')}`), sql` AND `);
}

/** `EXISTS (survivor row colliding with the outer loser row `t`)`. */
function collidesWithSurvivor(parent: string, key: readonly string[], survivor: string): SQL {
  return sql`EXISTS (SELECT 1 FROM ${sql.identifier(parent)} s WHERE s.org_id = ${uuid(survivor)} AND ${keyMatch(key)})`;
}

/**
 * Re-point every child FK off the loser's colliding rows and onto the survivor
 * row they collide with, then delete the duplicates. Returns the delete count
 * and the per-child re-home counts so the caller can surface both.
 *
 * Order is load-bearing: a delete before the last re-home is the 23503 this
 * whole helper exists to prevent.
 */
async function rehomeChildrenThenDelete(
  parent: string,
  key: readonly string[],
  children: readonly ChildRef[],
  loser: string,
  survivor: string,
): Promise<{ dropped: number; rehomed: Array<{ table: string; count: number }> }> {
  const p = sql.identifier(parent);
  const rehomed: Array<{ table: string; count: number }> = [];

  for (const child of children) {
    const col = sql.identifier(child.column);
    const n = await run(sql`
      UPDATE ${sql.identifier(child.table)} AS c
         SET ${col} = s.id
        FROM ${p} t
        JOIN ${p} s ON s.org_id = ${uuid(survivor)} AND ${keyMatch(key)}
       WHERE t.org_id = ${uuid(loser)}
         AND c.${col} = t.id`);
    if (n > 0) rehomed.push({ table: child.table, count: n });
  }

  const dropped = await run(sql`
    DELETE FROM ${p} t
     WHERE t.org_id = ${uuid(loser)}
       AND ${collidesWithSurvivor(parent, key, survivor)}`);

  return { dropped, rehomed };
}

/** Read-only `count(*)` mirror of `rehomeChildrenThenDelete`'s DELETE, for `previewOrgMerge`. */
function collidingRowCount(parent: string, key: readonly string[]): (loser: string, survivor: string) => SQL {
  return (loser, survivor) => sql`
    SELECT count(*)::int AS n FROM ${sql.identifier(parent)} t
     WHERE t.org_id = ${uuid(loser)}
       AND ${collidesWithSurvivor(parent, key, survivor)}`;
}

/** `network_monitors: 3, snmp_devices: 1` — stable order, for the summary note. */
function describeRehomed(rehomed: Array<{ table: string; count: number }>): string {
  return rehomed.map((r) => `${r.table}: ${r.count}`).join(', ');
}

// discovered_assets' dedupe key is `ip_address` (discovered_assets_org_ip_unique).
const DISCOVERED_ASSET_KEY = ['ip_address'] as const;
const DISCOVERED_ASSET_CHILDREN: readonly ChildRef[] = [
  { table: 'network_monitors', column: 'asset_id' },
  { table: 'snmp_devices', column: 'asset_id' },
  { table: 'unifi_clients', column: 'discovered_asset_id' },
  { table: 'unifi_devices', column: 'discovered_asset_id' },
  { table: 'unifi_device_telemetry', column: 'discovered_asset_id' },
];

/**
 * discovered_assets, RESOLVE half. This is the ONLY custom executor that has
 * to run in the resolve phase, and it is not a style choice: `discovered_assets`
 * hangs off `sites` by `discovered_assets_site_org_fk (site_id, org_id) ->
 * sites(id, org_id) ON UPDATE CASCADE`. Postgres builds that action trigger
 * NON-deferrable, so the instant the walk repoints `sites` every asset under a
 * loser site is dragged into the survivor org — including the duplicate IP.
 * Resolving the collision from the `move` phase would therefore always be too
 * late, and the merge would die on 23505 (`discovered_assets_org_ip_unique`)
 * hundreds of tables earlier. See `MergePolicyPhase` in orgMerge.ts.
 */
const resolveDiscoveredAssets: CustomMergeExecutor = async (loser, survivor) => {
  const { dropped, rehomed } = await rehomeChildrenThenDelete(
    'discovered_assets',
    DISCOVERED_ASSET_KEY,
    DISCOVERED_ASSET_CHILDREN,
    loser,
    survivor,
  );
  const notes: string[] = [];
  if (dropped > 0) {
    notes.push(
      `discovered_assets: dropped ${dropped} duplicate discovered asset from the merged-away org (the survivor already had the same IP)`
      + (rehomed.length > 0
        ? ` and re-homed its monitoring children onto the survivor's asset (${describeRehomed(rehomed)})`
        : ''),
    );
  }
  return { moved: 0, dropped, notes };
};

/** discovered_assets, MOVE half — whatever the resolve pass left behind. */
const moveDiscoveredAssets: CustomMergeExecutor = async (loser, survivor) => ({
  moved: await run(buildRepoint('discovered_assets', loser, survivor)),
  dropped: 0,
  notes: [],
});

// ---------------------------------------------------------------------------
// ticket_drafts (P2-4, #4191) — `ticket_drafts_ticket_org_fk (ticket_id,
// org_id) -> tickets(id, org_id)`. `tickets` is a plain `repoint`, running
// unconditionally in the `move` phase: `UPDATE tickets SET org_id =
// survivor WHERE org_id = loser`. A ticket_drafts row left under the loser
// org_id would disagree with its own (now-repointed) ticket the instant that
// UPDATE runs — this is NOT a dedupe collision (there is no unique key to
// collide on), it is every loser-org row, unconditionally.
//
// Must run in RESOLVE, same reason as `discovered_assets` above: the walk
// completes `resolve` for every table before starting `move` on any, so
// deleting here guarantees zero ticket_drafts rows remain under the loser
// org by the time `tickets`' `move` half fires, regardless of table order.
// See the registry's `ticket_drafts` note for the full FK-disagreement
// mechanics.
// ---------------------------------------------------------------------------
const resolveTicketDrafts: CustomMergeExecutor = async (loser) => {
  const dropped = await run(sql`DELETE FROM ticket_drafts WHERE org_id = ${uuid(loser)}`);
  return {
    moved: 0,
    dropped,
    notes: dropped > 0
      ? [
          `ticket_drafts: dropped ${dropped} pending AI draft(s) from the merged-away org — drafts are `
          + 'ephemeral AI-proposed replies/resolution notes awaiting human approval, not the durable '
          + 'ticket_comments record, and cannot be re-tenanted (their composite FK to tickets would '
          + "disagree with the ticket's new org_id the instant it repoints); re-run triage under the "
          + 'surviving organization to regenerate one',
        ]
      : [],
  };
};

/** ticket_drafts, MOVE half — a no-op: resolve already leaves zero rows behind. */
const moveTicketDrafts: CustomMergeExecutor = async () => ({ moved: 0, dropped: 0, notes: [] });

// ---------------------------------------------------------------------------
// plugin_installations — `plugin_installations_org_catalog_unique (org_id,
// catalog_id)`. `plugin_logs.installation_id` is NOT NULL with a NO ACTION FK,
// so the old dedupe DELETE aborted the merge for any plugin that had ever
// logged. The survivor's installation of the same catalog plugin is the same
// plugin, so its log history simply continues there.
// ---------------------------------------------------------------------------
const mergePluginInstallations: CustomMergeExecutor = async (loser, survivor) => {
  const { dropped, rehomed } = await rehomeChildrenThenDelete(
    'plugin_installations',
    ['catalog_id'],
    [{ table: 'plugin_logs', column: 'installation_id' }],
    loser,
    survivor,
  );
  const moved = await run(buildRepoint('plugin_installations', loser, survivor));
  return {
    moved,
    dropped,
    notes: dropped > 0
      ? [
        `plugin_installations: dropped ${dropped} duplicate plugin installation from the merged-away org (the survivor already had the same plugin installed)`
        + (rehomed.length > 0 ? ` and re-homed its log history onto the survivor's installation (${describeRehomed(rehomed)})` : '')
        + ' — the merged-away installation\'s own settings were discarded, so re-check the plugin configuration under the surviving organization',
      ]
      : [],
  };
};

// ---------------------------------------------------------------------------
// playbook_definitions — `playbook_definitions_scope_name_uniq
// (COALESCE(org_id, nil-uuid), lower(name))`. `playbook_executions.playbook_id`
// is NOT NULL with a NO ACTION FK (aborts the merge), and
// `remediation_suggestions.playbook_id` is ON DELETE SET NULL (silently breaks
// the link). Both are re-homed onto the survivor's same-named playbook, which
// keeps the execution history attached to something runnable.
// ---------------------------------------------------------------------------
const mergePlaybookDefinitions: CustomMergeExecutor = async (loser, survivor) => {
  const { dropped, rehomed } = await rehomeChildrenThenDelete(
    'playbook_definitions',
    ['lower({name})'],
    [
      { table: 'playbook_executions', column: 'playbook_id' },
      { table: 'remediation_suggestions', column: 'playbook_id' },
    ],
    loser,
    survivor,
  );
  const moved = await run(buildRepoint('playbook_definitions', loser, survivor));
  return {
    moved,
    dropped,
    notes: dropped > 0
      ? [
        `playbook_definitions: dropped ${dropped} duplicate playbook from the merged-away org whose name already existed under the survivor`
        + (rehomed.length > 0 ? ` and re-homed its history onto the survivor's playbook (${describeRehomed(rehomed)})` : '')
        + " — the survivor's STEPS are the ones that will run from now on; compare them if the two playbooks had diverged",
      ]
      : [],
  };
};

// ---------------------------------------------------------------------------
// pam_signer_groups — `pam_signer_groups_org_id_name_unique (org_id, name)`.
// FOUND BY THE FINAL-REVIEW SWEEP, not by the earlier one: this table's inbound
// FK is `pam_rules.match_signer_group_id ON DELETE RESTRICT`, not NO ACTION.
// RESTRICT is if anything WORSE — it is checked immediately and cannot be
// deferred at all — so a partner with one PAM rule matching a signer group of a
// name that both orgs use could never merge those orgs.
// ---------------------------------------------------------------------------
const mergePamSignerGroups: CustomMergeExecutor = async (loser, survivor) => {
  const { dropped, rehomed } = await rehomeChildrenThenDelete(
    'pam_signer_groups',
    ['name'],
    [{ table: 'pam_rules', column: 'match_signer_group_id' }],
    loser,
    survivor,
  );
  const moved = await run(buildRepoint('pam_signer_groups', loser, survivor));
  return {
    moved,
    dropped,
    notes: dropped > 0
      ? [
        `pam_signer_groups: dropped ${dropped} duplicate signer group from the merged-away org whose name already existed under the survivor`
        + (rehomed.length > 0 ? ` and re-pointed its PAM rules at the survivor's group (${describeRehomed(rehomed)})` : '')
        + " — the survivor's CERTIFICATE/publisher list is now the one those rules match on; review it before relying on them",
      ]
      : [],
  };
};

// ---------------------------------------------------------------------------
// incidents — `incidents_source_ref_unique (org_id, source_type, source_ref)
// WHERE source_ref IS NOT NULL`. Unlike the four above, this one does NOT
// delete, and no amount of child re-homing would make deleting right: an
// incident is a case file, and `incident_actions` / `incident_evidence` are its
// response record, not derived rows that can be re-attached to somebody else's
// incident. Two orgs promoting the same EDR finding produced two genuinely
// different investigations.
//
// So the collision is neutralized instead, mirroring `fleet_findings`: NULLing
// `source_ref` removes the row from the PARTIAL index (verified nullable — the
// column has no NOT NULL and the index is `WHERE source_ref IS NOT NULL`) while
// the incident, its timeline and both children survive intact and re-tenant
// normally. The one thing that is genuinely lost is the EDR de-duplication
// hook: `routes/incidents.helpers.ts` uses (source_type, source_ref) in a NOT
// EXISTS to avoid re-promoting a finding, so the same finding could be promoted
// again later. The old value is therefore preserved verbatim in `summary` —
// the same "record it where a human will see it" move `audit_baselines` makes
// when it renames.
//
// Plain `=` on source_type, not IS NOT DISTINCT FROM: a NULL source_type never
// collides in the partial index, and clearing the source_ref of a row that was
// not actually colliding would destroy the de-dup hook for nothing.
// ---------------------------------------------------------------------------
const mergeIncidents: CustomMergeExecutor = async (loser, survivor) => {
  const neutralized = await run(sql`
    UPDATE incidents AS t
       SET source_ref = NULL,
           summary = COALESCE(t.summary || E'\n\n', '')
                     || 'Organization merge: this incident''s source reference ('
                     || t.source_type || ':' || t.source_ref
                     || ') was cleared because the surviving organization already had an incident for the same source finding.',
           updated_at = now()
     WHERE t.org_id = ${uuid(loser)}
       AND t.source_ref IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM incidents AS s
          WHERE s.org_id = ${uuid(survivor)}
            AND s.source_ref IS NOT NULL
            AND s.source_ref = t.source_ref
            AND s.source_type = t.source_type
       )`);
  const moved = await run(buildRepoint('incidents', loser, survivor));
  return {
    moved,
    dropped: 0,
    notes: neutralized > 0
      ? [
        `incidents: cleared the source reference on ${neutralized} incident from the merged-away org that duplicated a survivor incident (the incident, its actions and its evidence were all kept, and the old reference is recorded in the incident summary) — the same source finding could be promoted to a new incident again`,
      ]
      : [],
  };
};

// ---------------------------------------------------------------------------
// contacts — `contacts_org_primary_uniq ON contacts (org_id) WHERE is_primary
// AND site_id IS NULL`. Only the ORG-level primary can collide: the
// site-level twin is keyed on site_id alone, and sites move to the survivor
// keeping their ids, so no site-level pair can ever collide. Demote the
// loser's org-level primary, then repoint everything. Never delete — a
// contact is a real person with tickets, quotes and portal logins hanging
// off it.
// ---------------------------------------------------------------------------
const mergeContacts: CustomMergeExecutor = async (loser, survivor) => {
  const demoted = await run(sql`
    UPDATE contacts AS t
       SET is_primary = false, updated_at = now()
     WHERE t.org_id = ${uuid(loser)}
       AND t.is_primary
       AND t.site_id IS NULL
       AND EXISTS (
         SELECT 1 FROM contacts AS s
          WHERE s.org_id = ${uuid(survivor)} AND s.is_primary AND s.site_id IS NULL
       )`);
  const moved = await run(buildRepoint('contacts', loser, survivor));
  return {
    moved,
    dropped: 0,
    notes: demoted > 0
      ? [`contacts: demoted ${demoted} primary contact from the merged-away org — the survivor's existing primary contact was kept`]
      : [],
  };
};

// ---------------------------------------------------------------------------
// backup_configs — `backup_configs_org_default_uq ON backup_configs(org_id)
// WHERE is_default`. Clear the loser's default flag when the survivor
// already has one, then repoint. NEVER delete: the row carries org-owned
// storage credentials (provider_config / encryption_key) and backup_chains,
// backup_snapshots and restore_jobs all reference it.
// ---------------------------------------------------------------------------
const mergeBackupConfigs: CustomMergeExecutor = async (loser, survivor) => {
  const cleared = await run(sql`
    UPDATE backup_configs AS t
       SET is_default = false, updated_at = now()
     WHERE t.org_id = ${uuid(loser)}
       AND t.is_default
       AND EXISTS (
         SELECT 1 FROM backup_configs AS s WHERE s.org_id = ${uuid(survivor)} AND s.is_default
       )`);
  const moved = await run(buildRepoint('backup_configs', loser, survivor));
  return {
    moved,
    dropped: 0,
    notes: cleared > 0
      ? [`backup_configs: cleared the default flag on ${cleared} backup destination from the merged-away org (credentials kept) — the survivor's default destination was kept`]
      : [],
  };
};

// ---------------------------------------------------------------------------
// audit_baselines — no unique index at all, but `auditBaselineJobs.ts` joins
// devices to baselines on (org_id, os_type) WHERE is_active, so two active
// baselines for one (org, os_type) would silently double-evaluate every
// device. Deactivate the loser's colliding actives, then repoint. NEVER
// delete: audit_baseline_results and audit_baseline_apply_approvals are both
// ON DELETE CASCADE off baseline_id.
// ---------------------------------------------------------------------------
const mergeAuditBaselines: CustomMergeExecutor = async (loser, survivor) => {
  const notes: string[] = [];

  // (a) One active baseline per (org, os_type). On droplets migrated before
  //     the 0001 squash this is a HARD constraint —
  //     `audit_baselines_one_active_per_org_os ON audit_baselines(org_id,
  //     os_type) WHERE is_active` from 0047-be21-audit-baselines.sql:91.
  //     On fresh databases it is only behavioural (autoMigrate marks 0002-0065
  //     applied without running them, and 0001-baseline.sql never recreates
  //     it), but the behaviour matters just as much: auditBaselineJobs.ts:62
  //     joins devices to baselines on (org_id, os_type) WHERE is_active, so two
  //     actives silently double-evaluate every device.
  const deactivated = await run(sql`
    UPDATE audit_baselines AS t
       SET is_active = false, updated_at = now()
     WHERE t.org_id = ${uuid(loser)}
       AND t.is_active
       AND EXISTS (
         SELECT 1 FROM audit_baselines AS s
          WHERE s.org_id = ${uuid(survivor)} AND s.is_active AND s.os_type = t.os_type
       )`);
  if (deactivated > 0) {
    notes.push(
      `audit_baselines: deactivated ${deactivated} baseline from the merged-away org that collided with an active survivor baseline for the same OS (history kept; re-activate manually if it was the one you wanted)`,
    );
  }

  // (b) `audit_baselines_org_name_os_profile_uniq ON audit_baselines(org_id,
  //     name, os_type, profile)` — same provenance as (a): present on
  //     pre-squash droplets, ABSENT on fresh databases. A merge that only ran
  //     step (a) would raise 23505 in production while passing every test on a
  //     fresh DB. Renaming is deterministic, fires only on an actual collision,
  //     and is a no-op where the index doesn't exist. `left(name, 182)` keeps
  //     the result inside varchar(200) (18 chars of suffix) so a long name
  //     can't turn this into a 22001.
  const renamed = await run(sql`
    UPDATE audit_baselines AS t
       SET name = left(t.name, 182) || ' (merged ' || left(${uuid(loser)}::text, 8) || ')',
           updated_at = now()
     WHERE t.org_id = ${uuid(loser)}
       AND EXISTS (
         SELECT 1 FROM audit_baselines AS s
          WHERE s.org_id = ${uuid(survivor)}
            AND s.name = t.name
            AND s.os_type = t.os_type
            AND s.profile = t.profile
       )`);
  if (renamed > 0) {
    notes.push(
      `audit_baselines: renamed ${renamed} baseline from the merged-away org whose name/OS/profile already existed under the survivor (suffixed with the merged org id)`,
    );
  }

  const moved = await run(buildRepoint('audit_baselines', loser, survivor));
  return { moved, dropped: 0, notes };
};

// ---------------------------------------------------------------------------
// api_keys / enrollment_keys — the design doc is explicit that the loser's
// org-bound capabilities are "revoked, not repointed" (controller ruling R2).
// Repointing alone would hand the survivor a live credential that the merged
// org's contacts still hold. Both revoke through the table's ESTABLISHED
// mechanism, mirroring services/tenantLifecycle.ts, and both revoke BEFORE the
// repoint so the predicate can key on the loser's org_id and the SURVIVOR's own
// keys are never touched. Getting that order wrong would silently kill the
// surviving org's live credentials — the single most damaging mistake available
// in this file.
// ---------------------------------------------------------------------------
const mergeApiKeys: CustomMergeExecutor = async (loser, survivor) => {
  const revoked = await run(sql`
    UPDATE api_keys
       SET status = 'revoked', updated_at = now()
     WHERE org_id = ${uuid(loser)}
       AND status <> 'revoked'`);
  const moved = await run(buildRepoint('api_keys', loser, survivor));
  return {
    moved,
    dropped: 0,
    notes: revoked > 0
      ? [`api_keys: revoked ${revoked} API key belonging to the merged-away org — they are org-bound capabilities and do not transfer; re-issue under the surviving organization if any integration still needs them`]
      : [],
  };
};

const mergeEnrollmentKeys: CustomMergeExecutor = async (loser, survivor) => {
  const expired = await run(sql`
    UPDATE enrollment_keys
       SET expires_at = now()
     WHERE org_id = ${uuid(loser)}
       AND (expires_at IS NULL OR expires_at > now())`);
  const moved = await run(buildRepoint('enrollment_keys', loser, survivor));
  return {
    moved,
    dropped: 0,
    notes: expired > 0
      ? [`enrollment_keys: expired ${expired} enrollment key belonging to the merged-away org — a still-valid key must not be able to enroll devices into the survivor; mint a new one if needed`]
      : [],
  };
};

// ---------------------------------------------------------------------------
// pax8_orders — `pax8_orders_one_mutable_direct_per_org_uq ON
// pax8_orders(partner_id, org_id) WHERE source = 'direct' AND status IN
// ('draft','awaiting_details')` (verified in
// migrations/2026-07-14-pax8-direct-draft-uniqueness.sql). At most one
// mutable direct order per customer, so a colliding loser draft must go.
// Deleting is safe here and only here: pax8_order_lines' composite FK is ON
// DELETE CASCADE and nothing else references pax8_orders. Quote-sourced
// orders are deliberately outside the index and always move.
// ---------------------------------------------------------------------------
const mergePax8Orders: CustomMergeExecutor = async (loser, survivor) => {
  const dropped = await run(sql`
    DELETE FROM pax8_orders AS t
     WHERE t.org_id = ${uuid(loser)}
       AND t.source = 'direct'
       AND t.status IN ('draft', 'awaiting_details')
       AND EXISTS (
         SELECT 1 FROM pax8_orders AS s
          WHERE s.org_id = ${uuid(survivor)}
            AND s.partner_id = t.partner_id
            AND s.source = 'direct'
            AND s.status IN ('draft', 'awaiting_details')
       )`);
  const moved = await run(buildRepoint('pax8_orders', loser, survivor));
  return {
    moved,
    dropped,
    notes: dropped > 0
      ? [`pax8_orders: discarded ${dropped} unsubmitted direct draft order from the merged-away org — the survivor already had a mutable draft`]
      : [],
  };
};

// ---------------------------------------------------------------------------
// fleet_findings — `fleet_findings_live_episode_uq ON fleet_findings(org_id,
// kind, semantic_key, algorithm_version) WHERE resolved_at IS NULL`. Resolve
// (never delete) the loser's colliding live episodes so they leave the
// partial index, then repoint everything. Deleting would cascade away
// fleet_remediation_runs (composite FK on (finding_id, org_id)) and
// fleet_finding_devices. Mirrors reconcile.ts's own resolution write shape.
// ---------------------------------------------------------------------------
const mergeFleetFindings: CustomMergeExecutor = async (loser, survivor) => {
  const resolved = await run(sql`
    UPDATE fleet_findings AS t
       SET status = 'resolved',
           resolved_at = now(),
           resolution_reason = 'org_merge',
           updated_at = now()
     WHERE t.org_id = ${uuid(loser)}
       AND t.resolved_at IS NULL
       AND EXISTS (
         SELECT 1 FROM fleet_findings AS s
          WHERE s.org_id = ${uuid(survivor)}
            AND s.resolved_at IS NULL
            AND s.kind = t.kind
            AND s.semantic_key = t.semantic_key
            AND s.algorithm_version = t.algorithm_version
       )`);
  const moved = await run(buildRepoint('fleet_findings', loser, survivor));
  return {
    moved,
    dropped: 0,
    notes: resolved > 0
      ? [`fleet_findings: auto-resolved ${resolved} live finding from the merged-away org that duplicated a survivor finding (remediation history kept)`]
      : [],
  };
};

// ---------------------------------------------------------------------------
// ai_agents — `ai_agents_org_kind_uq ON ai_agents(org_id, kind) WHERE
// disabled_at IS NULL`. Disable (never delete) the loser's colliding agents so
// they leave the partial index, then repoint everything.
//
// Deleting is not an option: ai_agent_runs.agent_id, ai_sessions.agent_id and
// automations.managed_by_agent_id are all ON DELETE RESTRICT, and the loser's
// runs are `leave-for-erasure` — they are still pointing at the row when the
// merge runs, so the DELETE would raise 23503 and abort the whole merge.
//
// The write mirrors agentService.disableAgent (`disabled_at`, `enabled=false`,
// `updated_at`) so a merge-disabled agent is indistinguishable from a
// hand-disabled one to every reader. `disabled_by` is deliberately left NULL:
// no user disabled it, the merge did, and the note below is what tells the
// operator. The partner-wide rows (org_id IS NULL) are out of merge scope
// entirely, so `ai_agents_partner_kind_uq` cannot collide.
//
// Task 17 (A2-7, #4192) — a repoint alone would hand the survivor org a
// `supervisedActionKeys` grant nobody on the survivor ever earned, while the
// evidence that justified it (`ai_agent_op_evidence`) stays behind on the dead
// loser shell (leave-for-erasure, `orgMergeRegistry.ts`). So every loser-org
// agent's `act_assets.supervisedActionKeys` is cleared to `[]` BEFORE the
// repoint — the survivor keeps the agent's configuration but must re-earn
// graduated authority under its own evidence. Scoped to `org_id = loser`
// only, never `org_id IS NULL`, so partner-wide rows are untouched.
// ---------------------------------------------------------------------------
const mergeAiAgents: CustomMergeExecutor = async (loser, survivor) => {
  const disabled = await run(sql`
    UPDATE ai_agents AS t
       SET disabled_at = now(),
           enabled = false,
           updated_at = now()
     WHERE t.org_id = ${uuid(loser)}
       AND t.disabled_at IS NULL
       AND EXISTS (
         SELECT 1 FROM ai_agents AS s
          WHERE s.org_id = ${uuid(survivor)}
            AND s.disabled_at IS NULL
            AND s.kind = t.kind
       )`);
  // Deliberately NOT scoped to `disabled_at IS NULL`: the disable-collision
  // UPDATE immediately above excludes any agent it just disabled (and any
  // agent disabled before the merge) from THIS statement if it were, and
  // `buildRepoint` below repoints every loser-org agent unconditionally
  // regardless of disabled_at — so a disabled agent's graduated keys would
  // otherwise ride into the survivor org untouched, evidence and all, while
  // the operator note above tells them to "re-enable it manually". Every
  // loser-org agent's keys must be cleared, disabled or not.
  const clearedKeys = await run(sql`
    UPDATE ai_agents
       SET act_assets = jsonb_set(coalesce(act_assets, '{}'::jsonb), '{supervisedActionKeys}', '[]'::jsonb),
           updated_at = now()
     WHERE org_id = ${uuid(loser)}
       AND jsonb_array_length(coalesce(act_assets -> 'supervisedActionKeys', '[]'::jsonb)) > 0`);
  const moved = await run(buildRepoint('ai_agents', loser, survivor));
  return {
    moved,
    dropped: 0,
    notes: [
      ...(disabled > 0
        ? [`ai_agents: disabled ${disabled} agent from the merged-away org that duplicated an active survivor agent of the same kind (configuration kept — re-enable it manually if it was the one you wanted)`]
        : []),
      ...(clearedKeys > 0
        ? [`ai_agents: cleared graduated supervised action keys on ${clearedKeys} agent(s) from the merged-away org — a survivor org must re-earn them (evidence is leave-for-erasure)`]
        : []),
    ],
  };
};

// ---------------------------------------------------------------------------
// organization_users — a membership row carries per-org access scoping in
// `site_ids` / `device_group_ids`. A plain dedupe DELETE would discard the
// loser row's grants outright, so union them into the surviving membership
// first, then delete the now-redundant loser row; loser rows for a user with
// NO survivor membership just repoint.
//
// Keyed on `user_id` ALONE, not (user_id, role_id). Keying on the pair would
// leave a user who holds different roles in the two orgs with BOTH membership
// rows under the survivor, and `permissions.ts` resolveOrgAxis selects the
// membership with `.limit(1)` and NO `ORDER BY` — so which role that user gets
// would be decided by Postgres's row order. A merge must not be able to
// produce a nondeterministic permission set.
//
// Role-conflict resolution (controller ruling): the SURVIVOR org's existing
// membership wins — its `role_id` is kept untouched and the loser's role is
// discarded. That is the conservative direction (the survivor is the org that
// continues to exist, and its role assignment was made deliberately), and
// every discarded role is named per-user in the merge summary so an admin can
// re-grant if the loser's role was the higher one.
//
// NULL semantics matter and are asymmetric: `permissions.ts:171` maps the
// column through `orgUser.siteIds || undefined`, and `siteAccessCheck`
// treats `undefined` as UNRESTRICTED while an empty array denies every
// site. So the union of "unrestricted" with anything is unrestricted (NULL),
// and the union of two lists is their distinct concatenation — never NULL by
// accident, hence the COALESCE around array_agg (which returns NULL, not
// '{}', over zero rows).
//
// If the survivor already had several membership rows for one user (there is
// no unique constraint, so it is representable), every one of them receives
// the union. That ambiguity pre-dates the merge; unioning into all of them is
// deterministic and monotone, and never shrinks anyone's access.
// ---------------------------------------------------------------------------
const arrayUnion = (column: 'site_ids' | 'device_group_ids', loser: string): SQL => {
  const col = sql.raw(column);
  return sql`CASE
      WHEN s.${col} IS NULL OR EXISTS (
        SELECT 1 FROM organization_users AS l
         WHERE l.org_id = ${uuid(loser)} AND l.user_id = s.user_id
           AND l.${col} IS NULL
      ) THEN NULL
      ELSE COALESCE((
        SELECT array_agg(DISTINCT u.x) FROM (
          SELECT x FROM unnest(s.${col}) AS su(x)
          UNION ALL
          SELECT lu.x
            FROM organization_users AS l, unnest(l.${col}) AS lu(x)
           WHERE l.org_id = ${uuid(loser)} AND l.user_id = s.user_id
        ) AS u(x)
      ), '{}'::uuid[])
    END`;
};

const mergeOrganizationUsers: CustomMergeExecutor = async (loser, survivor) => {
  // Collected BEFORE the delete, while both rows still exist. `roles` is a
  // parent of organization_users, so parents-first ordering has already
  // repointed the loser's role rows — their ids and names are unchanged, so
  // both sides still resolve.
  const conflicts = (await dbModule.db.execute(sql`
    SELECT DISTINCT
           u.email        AS email,
           lr.name        AS loser_role,
           sr.name        AS survivor_role
      FROM organization_users AS l
      JOIN organization_users AS s ON s.org_id = ${uuid(survivor)} AND s.user_id = l.user_id
      JOIN users AS u  ON u.id  = l.user_id
      LEFT JOIN roles AS lr ON lr.id = l.role_id
      LEFT JOIN roles AS sr ON sr.id = s.role_id
     WHERE l.org_id = ${uuid(loser)}
       AND l.role_id <> s.role_id
     ORDER BY 1, 2, 3`)) as unknown as Array<{
    email: string;
    loser_role: string | null;
    survivor_role: string | null;
  }>;

  const unioned = await run(sql`
    UPDATE organization_users AS s
       SET site_ids = ${arrayUnion('site_ids', loser)},
           device_group_ids = ${arrayUnion('device_group_ids', loser)}
     WHERE s.org_id = ${uuid(survivor)}
       AND EXISTS (
         SELECT 1 FROM organization_users AS l
          WHERE l.org_id = ${uuid(loser)} AND l.user_id = s.user_id
       )`);
  const dropped = await run(sql`
    DELETE FROM organization_users AS l
     WHERE l.org_id = ${uuid(loser)}
       AND EXISTS (
         SELECT 1 FROM organization_users AS s
          WHERE s.org_id = ${uuid(survivor)} AND s.user_id = l.user_id
       )`);
  const moved = await run(buildRepoint('organization_users', loser, survivor));

  const notes: string[] = [];
  if (dropped > 0) {
    notes.push(
      `organization_users: folded ${dropped} duplicate membership into ${unioned} existing survivor membership — site and device-group grants were unioned, not replaced`,
    );
  }
  for (const c of conflicts) {
    notes.push(
      `organization_users role conflict for ${c.email}: role '${c.loser_role ?? 'unknown'}' from the merged-away org was discarded, survivor role '${c.survivor_role ?? 'unknown'}' kept — re-grant manually if the discarded role was the broader one`,
    );
  }
  return { moved, dropped, notes };
};

// ---------------------------------------------------------------------------
// reports — `reports_source_ai_agent_schedule_uniq (org_id,
// source_ai_agent_schedule_id) WHERE source_ai_agent_schedule_id IS NOT NULL`
// (P2-3, #4190). A partner-wide narrative schedule mints one system-managed
// definition per org, so two orgs under the same partner both hold a row for
// the SAME schedule id; a plain repoint collides on 23505 and aborts the merge.
//
// `report_runs.report_id` is NOT NULL with a NO ACTION FK (verified against
// pg_constraint), so a dedupe DELETE would raise 23503 instead — and even if it
// did not, the runs are the customer's generated report artifacts, so dropping
// them is not on the table. The survivor's definition for the same schedule is
// the same weekly narrative under a different id, so the loser's run history
// simply continues there. `ai_agent_runs.report_run_id` keeps pointing at the
// same (untouched) report_runs rows, so run traces stay linked.
//
// The key deliberately carries no keyWhere: `keyMatch` compares with a plain
// `=`, which is NULL-blind, so ordinary reports (NULL
// source_ai_agent_schedule_id) never match each other — exactly the semantics
// of the partial index this mirrors.
// ---------------------------------------------------------------------------
const REPORTS_KEY = ['source_ai_agent_schedule_id'] as const;

const mergeReports: CustomMergeExecutor = async (loser, survivor) => {
  const { dropped, rehomed } = await rehomeChildrenThenDelete(
    'reports',
    REPORTS_KEY,
    [{ table: 'report_runs', column: 'report_id' }],
    loser,
    survivor,
  );
  const moved = await run(buildRepoint('reports', loser, survivor));
  return {
    moved,
    dropped,
    notes: dropped > 0
      ? [
        `reports: dropped ${dropped} duplicate AI narrative report definition from the merged-away org (the survivor already had one for the same schedule; the merged-away definition's own name/config/execution-scope fields were discarded — re-check the surviving definition)`
        + (rehomed.length > 0
          ? ` and re-homed its generated reports onto the survivor's definition (${describeRehomed(rehomed)})`
          : ''),
      ]
      : [],
  };
};

// ---------------------------------------------------------------------------
// automation_resource_bindings — the binding's org_id copies its parent
// automation owner, while expected_resource_org_id records the referenced
// resource owner observed at admission. Both must advance in the same merge
// transaction. Updating only org_id leaves an out-of-tenant expected owner and
// fails the deferred binding guard at commit; partner-owned and system
// references carry NULL here and are intentionally untouched.
// ---------------------------------------------------------------------------
const mergeAutomationResourceBindings: CustomMergeExecutor = async (loser, survivor) => ({
  moved: await run(sql`
    UPDATE automation_resource_bindings
       SET org_id = ${uuid(survivor)},
           expected_resource_org_id = CASE
             WHEN expected_resource_org_id = ${uuid(loser)} THEN ${uuid(survivor)}
             ELSE expected_resource_org_id
           END,
           updated_at = now()
     WHERE org_id = ${uuid(loser)}`),
  dropped: 0,
  notes: [],
});

/**
 * The `move`-phase half of every `custom` table (which, for all but one of
 * them, is the whole executor).
 */
export const CUSTOM_EXECUTORS: Readonly<Record<string, CustomMergeExecutor>> = {
  automation_resource_bindings: mergeAutomationResourceBindings,
  contacts: mergeContacts,
  backup_configs: mergeBackupConfigs,
  audit_baselines: mergeAuditBaselines,
  pax8_orders: mergePax8Orders,
  fleet_findings: mergeFleetFindings,
  ai_agents: mergeAiAgents,
  organization_users: mergeOrganizationUsers,
  api_keys: mergeApiKeys,
  enrollment_keys: mergeEnrollmentKeys,
  discovered_assets: moveDiscoveredAssets,
  plugin_installations: mergePluginInstallations,
  playbook_definitions: mergePlaybookDefinitions,
  pam_signer_groups: mergePamSignerGroups,
  incidents: mergeIncidents,
  reports: mergeReports,
  ticket_drafts: moveTicketDrafts,
};

/**
 * Custom tables that ALSO need a `resolve`-phase half, keyed the same way.
 *
 * Two reasons land a table here: a cascade-re-tenanted child whose `org_id`
 * is rewritten by a parent's non-deferrable ON UPDATE CASCADE trigger before
 * the walk would otherwise reach it (`discovered_assets`, via `sites`), or a
 * composite FK that a SIBLING table's own plain `repoint` drags out from
 * under it (`ticket_drafts`, via `tickets`). `MergePolicyPhase` in
 * orgMerge.ts is the full explanation.
 *
 * Every key here MUST also appear in CUSTOM_EXECUTORS — a resolve half with no
 * move half would leave rows stranded under the dead loser org. The registry
 * contract test asserts that.
 */
export const CUSTOM_RESOLVE_EXECUTORS: Readonly<Record<string, CustomMergeExecutor>> = {
  discovered_assets: resolveDiscoveredAssets,
  ticket_drafts: resolveTicketDrafts,
};

/**
 * Read-only `SELECT count(*)` mirrors of the two executors that REVOKE rather
 * than drop, for `previewOrgMerge`.
 *
 * These are not covered by `CUSTOM_WOULD_DROP_COUNTS` because nothing is
 * deleted — every key still moves to the survivor, just dead. That is exactly
 * why the preview has to say so out loud: an operator reading a plan whose only
 * loss column is `wouldDrop` sees `api_keys: 4 rows, 0 dropped` and reasonably
 * concludes the merge is non-destructive for their integrations, when in fact
 * all four are about to stop authenticating. Each predicate MUST stay identical
 * to its executor's above (`mergeApiKeys`, `mergeEnrollmentKeys`).
 */
export const CUSTOM_WOULD_REVOKE_COUNTS: Readonly<Record<string, (loser: string) => SQL>> = {
  api_keys: (loser) => sql`
    SELECT count(*)::int AS n FROM api_keys
     WHERE org_id = ${uuid(loser)}
       AND status <> 'revoked'`,
  enrollment_keys: (loser) => sql`
    SELECT count(*)::int AS n FROM enrollment_keys
     WHERE org_id = ${uuid(loser)}
       AND (expires_at IS NULL OR expires_at > now())`,
};

/**
 * Read-only `SELECT count(*)` mirrors of every custom executor that DELETEs,
 * for `previewOrgMerge`. Tables absent from this map drop nothing, so preview
 * reports `wouldDrop: 0` for them (`contacts`, `backup_configs`,
 * `audit_baselines`, `fleet_findings`, `ai_agents` and `incidents` all mutate
 * instead).
 *
 * `ticket_drafts` drops EVERY loser-org row unconditionally (no collision
 * key), unlike the others below — its mirror is just `loserRows`, matching
 * `resolveTicketDrafts`'s unconditional DELETE.
 */
export const CUSTOM_WOULD_DROP_COUNTS: Readonly<Record<string, (loser: string, survivor: string) => SQL>> = {
  ticket_drafts: (loser) => sql`SELECT count(*)::int AS n FROM ticket_drafts WHERE org_id = ${uuid(loser)}`,
  discovered_assets: collidingRowCount('discovered_assets', DISCOVERED_ASSET_KEY),
  plugin_installations: collidingRowCount('plugin_installations', ['catalog_id']),
  playbook_definitions: collidingRowCount('playbook_definitions', ['lower({name})']),
  pam_signer_groups: collidingRowCount('pam_signer_groups', ['name']),
  reports: collidingRowCount('reports', REPORTS_KEY),
  pax8_orders: (loser, survivor) => sql`
    SELECT count(*)::int AS n FROM pax8_orders AS t
     WHERE t.org_id = ${uuid(loser)}
       AND t.source = 'direct'
       AND t.status IN ('draft', 'awaiting_details')
       AND EXISTS (
         SELECT 1 FROM pax8_orders AS s
          WHERE s.org_id = ${uuid(survivor)}
            AND s.partner_id = t.partner_id
            AND s.source = 'direct'
            AND s.status IN ('draft', 'awaiting_details')
       )`,
  organization_users: (loser, survivor) => sql`
    SELECT count(*)::int AS n FROM organization_users AS l
     WHERE l.org_id = ${uuid(loser)}
       AND EXISTS (
         SELECT 1 FROM organization_users AS s
          WHERE s.org_id = ${uuid(survivor)} AND s.user_id = l.user_id
       )`,
};
