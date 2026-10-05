/**
 * Foreign-key ledger for the GDPR org-erasure cascade (#4519).
 *
 * Enforced by `orgCascadeFkOnDelete.integration.test.ts`; that file's header
 * carries the full execution model. The short version: erasure empties a
 * tenant with a sequence of ordinary `DELETE` statements, so a foreign key
 * pointing at any table those statements touch is only safe if Postgres
 * clears it for us, or the referencing rows are already gone by the time that
 * statement runs. Anything else is an erasure failure that lies dormant until
 * a customer creates the first row in the referencing table -- exactly how
 * #4100 shipped.
 *
 * HOW TO USE THIS FILE
 *
 * You are here because the contract test failed. Do NOT reflexively add a
 * line. In order of preference:
 *
 *   1. Give the FK an explicit `ON DELETE` in a NEW, idempotent, fix-forward
 *      migration (never edit a shipped one). `CASCADE` when the child row is
 *      meaningless without the parent; `SET NULL` when it is an optional
 *      back-reference and `allColumnsNullable` is true. This is the answer for
 *      nearly every new FK.
 *   2. Register the child table in `CORE_ORG_CASCADE_DELETE_ORDER` -- plus
 *      every other list CLAUDE.md's cascade-registration table demands (device
 *      cascade, export policy, ...). Only valid if the child has its own
 *      `org_id`.
 *   3. Add an `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear in
 *      `services/tenantCascade.ts`, then record the FK in
 *      `ORG_CASCADE_FK_PRE_CLEARED` below. For child tables with no tenancy
 *      column of their own.
 *   4. Only if none of the above fits, add a line to
 *      `ORG_CASCADE_FK_UNSAFE` -- and if its `reason` is anything other than
 *      `child-not-deleted`, the test requires a `note` explaining it.
 *
 * BURN-DOWN
 *
 * `ORG_CASCADE_FK_UNSAFE` is a debt ledger seeded from a live migrated
 * database on 2026-09-03 so the contract could land green. It is expected to
 * SHRINK. Entries come off it by fix-forward migration -- never by relaxing
 * the test. A stale entry (the FK was dropped, renamed, given an ON DELETE, or
 * its child table joined the cascade set) fails the burn-down test, so a
 * migration that fixes an edge forces the matching line out in the same PR.
 *
 * One entry is NOT a latent shape but an erasure failure that fires today for
 * any tenant with the relevant rows -- `restore_jobs`, carrying a note with its
 * SQLSTATE and fix. It is pinned rather than fixed because #4519 is explicitly
 * scoped to making the debt visible; the migration is follow-up work.
 * `script_categories.parent_id` was the second such entry and came off this
 * ledger in #4873: `2026-10-13-120000-script-categories-parent-ownership-guard.sql`
 * gave it `ON DELETE SET NULL` (all referencing columns nullable, so the
 * classifier now calls it safe on its own) and added the DEFERRABLE
 * `script_categories_parent_guard` so the offending shape cannot be built.
 *
 * A `note` is not a fix. The two `partner_export_*` entries carry a reviewed
 * argument for why their edge is unreachable in practice, so they are not debt
 * in the ordinary sense -- but they stay pinned precisely because that
 * argument is transitive and nothing enforces it.
 *
 * Scope: the ORG cascade only. The device cascade
 * (`CORE_DEVICE_CASCADE_DELETE_TABLES`) and the partner purge have their own
 * contracts.
 */

/**
 * Why an edge is on the ledger. Recomputed from the catalog on every run and
 * checked against the stored value, so a `reason` cannot rot into a lie.
 */
export type OrgCascadeFkReason =
  /**
   * Ordinary debt, and the bulk of the ledger. No `ON DELETE` action, and
   * nothing in the erasure path empties the referencing table -- it has no
   * `org_id`, no cascade-list entry, and no pre-clear.
   */
  | 'child-not-deleted'
  /**
   * Both ends are emptied, in the wrong order: the parent goes first. Either
   * the parent is a step-1b pre-clear target while the child waits for the
   * cascade walk, or both are pre-cleared and the child sorts later in
   * `ASSOCIATED_SYSTEM_SCOPED_TABLES`.
   */
  | 'child-deleted-after-parent'
  /**
   * `ON DELETE SET NULL` over a column Postgres cannot null. Postgres accepts
   * such a constraint at DDL time and only fails when the delete runs -- with
   * 23502, not the 23503 everything else in this file produces.
   */
  | 'set-null-onto-not-null'
  /**
   * A self-referential edge whose deleted row set is not closed under it. The
   * end-of-statement exemption self-references normally get requires that
   * every row referencing a deleted row is deleted by the SAME statement;
   * a nullable `org_id` (partner-wide rows, epic #2135) breaks that, because
   * `WHERE org_id = $1` leaves the partner-owned rows behind.
   */
  | 'self-ref-open-row-set'
  /**
   * `ON DELETE SET DEFAULT`. Unused in this schema; safe only if the column
   * default happens to name a row that survives, which this contract does not
   * try to establish.
   */
  | 'set-default'
  /**
   * Not debt: the referencing table is emptied by an
   * `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear that runs before the parent's
   * DELETE. Only valid in `ORG_CASCADE_FK_PRE_CLEARED`.
   */
  | 'pre-cleared';

/** One FK edge, keyed the way `pg_constraint` keys it: (table, constraint name). */
export interface OrgCascadeFkRef {
  /** Referencing (child) table -- `pg_class` name of `pg_constraint.conrelid`. */
  childTable: string;
  /** `pg_constraint.conname`. Unique per table, not globally. */
  constraint: string;
  /** Referenced (parent) table. */
  parentTable: string;
  /** Recomputed and verified on every run; see `OrgCascadeFkReason`. */
  reason: OrgCascadeFkReason;
  /**
   * True when EVERY referencing column is nullable, i.e. a plain
   * `ON DELETE SET NULL` is a valid fix for this edge. Verified against the
   * catalog rather than trusted, because it is the triage signal that decides
   * whether the cheap fix is even available: `false` means the edge needs
   * `CASCADE`, a pre-clear, or a column-list `SET NULL`.
   */
  allColumnsNullable: boolean;
  /**
   * Why this entry is here beyond its `reason`. Required for every reason
   * except `child-not-deleted` and `pre-cleared`, whose shapes speak for
   * themselves.
   */
  note?: string;
}

/**
 * Edges the erasure path does not handle. Debt. Expected to shrink.
 *
 * Sorted by (parentTable, childTable, constraint) -- keep it that way; the
 * contract test enforces the order so diffs stay reviewable.
 */
export const ORG_CASCADE_FK_UNSAFE: ReadonlyArray<OrgCascadeFkRef> = Object.freeze([
  {
    childTable: 'configuration_policies',
    constraint: 'configuration_policies_parent_policy_id_fkey',
    parentTable: 'configuration_policies',
    reason: 'self-ref-open-row-set',
    allColumnsNullable: true,
    note:
      'Reviewed, NOT a live failure -- the same shape script_categories.parent_id had before #4873 '
      + '(fixed there with ON DELETE SET NULL), but closed by a guard rather than by the FK action. '
      + 'configuration_policies.org_id is nullable (partner-wide policies, epic '
      + '#2135), so the classifier cannot tell that `DELETE ... WHERE org_id = $1` still removes a '
      + 'row set closed under this self-reference. The DEFERRABLE constraint trigger '
      + '`configuration_policies_parent_guard` (2026-10-12-100000-config-policy-inheritance.sql, '
      + '#5080 W01) closes it: a child may only name a parent on its OWN owner axis -- an org-owned '
      + 'child names a same-org parent or its partner\'s partner-wide baseline; a partner-wide child '
      + 'names only a partner-wide parent of the same partner. So no SURVIVING row can point at a '
      + 'deleted one: partner-wide rows never reference org-owned rows, and another org\'s rows never '
      + 'reference this org\'s. Ownership itself moves only in system context, and the trigger '
      + 'revalidates the whole family at COMMIT (org merge runs SET CONSTRAINTS ALL DEFERRED), so a '
      + 'cross-owner edge cannot be committed in the first place. Pinned rather than fixed because '
      + 'both cheap actions are ruled out by the inheritance design (spec '
      + 'docs/superpowers/specs/config-policy/2026-09-06-config-policy-inheritance-design.md, '
      + 'Deletion): SET NULL would silently un-configure every child when a baseline is deleted, and '
      + 'deleting a parent alone must be REFUSED, which CASCADE would turn into a silent mass '
      + 'delete. The closure argument is proven empirically, not asserted: see the describe block '
      + '"config policy inheritance -- erasure row-set closure (live DB)" in '
      + 'configPolicyInheritance.integration.test.ts, which forges BOTH surviving-row shapes in '
      + 'SYSTEM scope and then runs the real cascadeDeleteOrg() and cascadeDeletePartner() over a '
      + 'parent+child family. (#5123)',
  },
  {
    childTable: 'partner_export_device_material_state',
    constraint: 'partner_export_device_material_state_org_id_fkey',
    parentTable: 'organizations',
    reason: 'child-not-deleted',
    allColumnsNullable: false,
    note:
      'Reviewed, not plain debt. The table is deliberately outside the cascade list (its rows are '
      + 'written only by SECURITY DEFINER triggers, so breeze_app cannot DELETE them at all). Erasure '
      + 'reaches them through device_id, which IS ON DELETE CASCADE, and devices is emptied long '
      + 'before organizations. Pinned anyway because that argument is transitive: it would stop '
      + 'holding, silently, if the device_id edge ever changed.',
  },
  {
    childTable: 'partner_export_site_material_state',
    constraint: 'partner_export_site_material_state_org_id_fkey',
    parentTable: 'organizations',
    reason: 'child-not-deleted',
    allColumnsNullable: false,
    note:
      'Reviewed, not plain debt. Same shape as partner_export_device_material_state above, reached '
      + 'through its ON DELETE CASCADE site_id edge instead.',
  },
  // Every FK-only child edge an ordinary, in-use org reaches came off this
  // ledger in 2026-12-13-110000 / -110100 / -110200, which gave each one an ON
  // DELETE action: CASCADE where the child is meaningless without its parent
  // (per-device results, alert notifications, ticket comments, AI messages,
  // login sessions, role permissions, ...), SET NULL for nullable
  // attributions on rows that must survive. partner_users -> users is the
  // subtle one: org erasure first detaches any user whose partner membership
  // still grants access without the erased org (org_id -> NULL, see
  // detachSharedIdentitiesFromOrg in tenantCascade.ts), so that cascade only
  // removes memberships of identities that are really being deleted.
  // Data-level proof: tenantCascadeFkChildren.integration.test.ts. The
  // entries below are the ones those migrations deliberately left alone.
  {
    childTable: 'partner_users',
    constraint: 'partner_users_role_id_roles_id_fk',
    parentTable: 'roles',
    reason: 'child-not-deleted',
    allColumnsNullable: false,
    note:
      'Not reached by an ordinary org: a partner membership names a partner-scope role, and only '
      + 'org-scoped roles are erased with the org. Left without an ON DELETE action on purpose -- '
      + 'CASCADE would silently delete a partner membership because a role went away.',
  },
  {
    childTable: 'config_policy_compliance_rules',
    constraint: 'config_policy_compliance_rules_remediation_script_id_scripts_id',
    parentTable: 'scripts',
    reason: 'child-not-deleted',
    allColumnsNullable: true,
    note:
      'SET NULL is an UPDATE of the child, and this table carries partner-export UPDATE triggers '
      + 'that have not been reviewed for a referential-action write; needs its own change.',
  },
  {
    childTable: 'patch_policies',
    constraint: 'patch_policies_post_install_script_id_scripts_id_fk',
    parentTable: 'scripts',
    reason: 'child-not-deleted',
    allColumnsNullable: true,
    note:
      'SET NULL would fire the config-policy feature-reference UPDATE gate triggers on '
      + 'patch_policies, which have not been reviewed for a referential-action write; needs its own change.',
  },
  {
    childTable: 'patch_policies',
    constraint: 'patch_policies_pre_install_script_id_scripts_id_fk',
    parentTable: 'scripts',
    reason: 'child-not-deleted',
    allColumnsNullable: true,
    note: 'Same as patch_policies_post_install_script_id_scripts_id_fk above.',
  },
  // script_versions -> scripts was `child-not-deleted` until W01a (#5612):
  // 2026-10-16-100000-script-versions-immutable.sql re-added that FK with
  // ON DELETE CASCADE, which is how a table with no org_id of its own erases
  // with its tenant. The FK to users (approved_by, added by the same
  // migration) ships ON DELETE SET NULL — a deleted approver nulls the
  // attribution rather than blocking erasure — so it needs no entry either.
  // Was `pre-cleared` until #5473: software_versions rows for a deleted org
  // used to have their own ASSOCIATED_SYSTEM_SCOPED_TABLES clearSql entry.
  // #5473 replaced it with deleteSoftwareCatalogsAndObjects (invoked in place
  // of the generic DELETE when the cascade walk reaches software_catalog),
  // which still deletes these rows -- first, and removes their uploaded S3
  // artifacts too, which a bare clearSql DELETE couldn't do -- but that
  // function is opaque to this file's classifier, so software_catalog no
  // longer counts as a table whose children this contract tracks. Not a
  // regression: software_deployments (the only other table with a live FK
  // into software_versions) is still a step-1b pre-clear, so it is always
  // empty before deleteSoftwareCatalogsAndObjects runs.
  { childTable: 'software_versions', constraint: 'software_versions_catalog_id_software_catalog_id_fk', parentTable: 'software_catalog', reason: 'child-not-deleted', allColumnsNullable: false },
  {
    childTable: 'config_policy_assignments',
    constraint: 'config_policy_assignments_assigned_by_users_id_fk',
    parentTable: 'users',
    reason: 'child-not-deleted',
    allColumnsNullable: true,
    note:
      'SET NULL would fire the assignment-integrity and partner-export UPDATE triggers on this '
      + 'table, which have not been reviewed for a referential-action write; needs its own change.',
  },
  {
    childTable: 'partner_service_principal_keys',
    constraint: 'partner_service_principal_keys_created_by_fkey',
    parentTable: 'users',
    reason: 'child-not-deleted',
    allColumnsNullable: false,
    note:
      'A partner credential with a NOT NULL creator. CASCADE would delete the partner\'s key because '
      + 'its creator left, and SET NULL needs the column made nullable first. Creating one requires '
      + 'partner-level access, and a creator with a membership that still grants access is detached, '
      + 'not deleted, by org erasure.',
  },
  {
    childTable: 'partner_service_principals',
    constraint: 'partner_service_principals_created_by_fkey',
    parentTable: 'users',
    reason: 'child-not-deleted',
    allColumnsNullable: false,
    note: 'Same as partner_service_principal_keys_created_by_fkey above.',
  },
  {
    childTable: 'partner_service_principals',
    constraint: 'partner_service_principals_updated_by_fkey',
    parentTable: 'users',
    reason: 'child-not-deleted',
    allColumnsNullable: false,
    note: 'Same as partner_service_principal_keys_created_by_fkey above.',
  },
  {
    childTable: 'patch_policies',
    constraint: 'patch_policies_created_by_users_id_fk',
    parentTable: 'users',
    reason: 'child-not-deleted',
    allColumnsNullable: true,
    note: 'Same trigger concern as patch_policies_post_install_script_id_scripts_id_fk.',
  },
  {
    childTable: 'script_versions',
    constraint: 'script_versions_created_by_users_id_fk',
    parentTable: 'users',
    reason: 'child-not-deleted',
    allColumnsNullable: true,
    note:
      'script_versions rows are immutable (script_versions_immutable raises on UPDATE), so SET NULL '
      + 'would fail. Versions of org-owned scripts go with their script by ON DELETE CASCADE; only a '
      + 'partner-wide script authored by a deleted org user can pin this.',
  },
]);

/**
 * Edges with no self-clearing `ON DELETE` whose referencing table IS emptied
 * first by an `ASSOCIATED_SYSTEM_SCOPED_TABLES` pre-clear. Handled, not debt.
 *
 * Pinned one-by-one rather than waved through per table, because the pre-clear
 * is hand-written SQL with its own WHERE join: `psa_ticket_mappings` needs
 * three separate arms to cover its three FKs, and a FOURTH FK on that table
 * would be silently uncovered if table membership alone satisfied the
 * contract. Listing every FK means a new one reds this test and sends the
 * author to read `clearSql`.
 *
 * What membership here does and does not assert: the test verifies the table
 * has a pre-clear and that the pre-clear runs before this parent's DELETE. It
 * cannot read the `clearSql` and confirm the join actually reaches the rows
 * this particular FK pins -- two entries below carry a note where the arm
 * demonstrably keys off a different column than the FK.
 *
 * Sorted by (parentTable, childTable, constraint), same as above.
 */
export const ORG_CASCADE_FK_PRE_CLEARED: ReadonlyArray<OrgCascadeFkRef> = Object.freeze([
  { childTable: 'psa_ticket_mappings', constraint: 'psa_ticket_mappings_alert_id_alerts_id_fk', parentTable: 'alerts', reason: 'pre-cleared', allColumnsNullable: true },
  {
    childTable: 'deployment_results',
    constraint: 'deployment_results_device_id_devices_id_fk',
    parentTable: 'devices',
    reason: 'pre-cleared',
    allColumnsNullable: false,
    note:
      'The deployment_results pre-clear keys off deployment_id only. A row pairing THIS org\'s '
      + 'device with another org\'s deployment would survive it and then pin `devices`. Cross-org '
      + 'pairing should be impossible, but nothing here proves it.',
  },
  { childTable: 'device_commands', constraint: 'device_commands_device_id_devices_id_fk', parentTable: 'devices', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'psa_ticket_mappings', constraint: 'psa_ticket_mappings_device_id_devices_id_fk', parentTable: 'devices', reason: 'pre-cleared', allColumnsNullable: true },
  { childTable: 'software_deployments', constraint: 'software_deployments_maintenance_window_id_maintenance_windows_', parentTable: 'maintenance_windows', reason: 'pre-cleared', allColumnsNullable: true },
  { childTable: 'software_deployments', constraint: 'software_deployments_org_id_organizations_id_fk', parentTable: 'organizations', reason: 'pre-cleared', allColumnsNullable: false },
  {
    childTable: 'partners',
    constraint: 'partners_service_management_psa_connection_id_fkey',
    parentTable: 'psa_connections',
    reason: 'pre-cleared',
    allColumnsNullable: true,
    note:
      'ON DELETE RESTRICT, so without the pre-clear this FK ABORTS the erasure rather than '
      + 'stranding a row. The clearSql un-wires mode and connection id together because '
      + 'partners_service_management_connection_chk is a biconditional. Expected to match zero '
      + 'rows in practice: PATCH /orgs/partners/me binds only partner-wide connections '
      + '(org_id IS NULL), which org erasure never deletes -- but that is an app-layer '
      + 'guarantee the schema does not enforce.',
  },
  { childTable: 'psa_ticket_mappings', constraint: 'psa_ticket_mappings_connection_id_psa_connections_id_fk', parentTable: 'psa_connections', reason: 'pre-cleared', allColumnsNullable: false },
  {
    childTable: 'access_review_items',
    constraint: 'access_review_items_role_id_roles_id_fk',
    parentTable: 'roles',
    reason: 'pre-cleared',
    allColumnsNullable: false,
    note:
      'NO ACTION on purpose: outside erasure a review item is evidence and must survive a later role '
      + 'delete (the role-delete route answers 409). The pre-clear keys off role_id IN the org\'s roles, '
      + 'the same column as this FK.',
  },
  { childTable: 'deployment_results', constraint: 'deployment_results_deployment_id_software_deployments_id_fk', parentTable: 'software_deployments', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'software_deployments', constraint: 'software_deployments_install_method_id_fkey', parentTable: 'software_install_methods', reason: 'pre-cleared', allColumnsNullable: true },
  { childTable: 'sso_sessions', constraint: 'sso_sessions_provider_id_sso_providers_id_fk', parentTable: 'sso_providers', reason: 'pre-cleared', allColumnsNullable: false },
  { childTable: 'user_sso_identities', constraint: 'user_sso_identities_provider_id_sso_providers_id_fk', parentTable: 'sso_providers', reason: 'pre-cleared', allColumnsNullable: false },
  {
    childTable: 'device_commands',
    constraint: 'device_commands_created_by_users_id_fk',
    parentTable: 'users',
    reason: 'pre-cleared',
    allColumnsNullable: true,
    note:
      'The device_commands pre-clear keys off device_id only, so a command a user of THIS org '
      + 'queued against ANOTHER org\'s device would survive it and then pin `users`. Cross-org queuing '
      + 'should be impossible, but nothing here proves it.',
  },
  { childTable: 'software_deployments', constraint: 'software_deployments_created_by_users_id_fk', parentTable: 'users', reason: 'pre-cleared', allColumnsNullable: true },
  { childTable: 'user_sso_identities', constraint: 'user_sso_identities_user_id_users_id_fk', parentTable: 'users', reason: 'pre-cleared', allColumnsNullable: false },
]);
