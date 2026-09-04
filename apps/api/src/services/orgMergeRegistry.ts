/**
 * Org-merge policy registry (org-lifecycle Wave 2, Task 1).
 *
 * Every table in `getOrgCascadeDeleteOrder()` (plus a handful of no-org_id
 * tables that a merge must still account for — see EXTRA_REQUIRED in the
 * contract test) needs exactly one merge policy. The contract test
 * (`orgMergeRegistry.integration.test.ts`) enforces completeness: it fails
 * loudly if a table is missing a policy, or if a policy names a table that
 * isn't actually in scope.
 *
 * This registry does not execute anything — it only classifies. The merge
 * engine (Task 2) and the hand-written executors (Task 3, `orgMerge.ts`
 * CUSTOM_EXECUTORS) consume it.
 *
 * Key/keyWhere literals use `{col}` placeholders for column references
 * inside expressions (`lower({name})`, `{source_ref} IS NOT NULL`) — the
 * Task-2 builders substitute the table alias. A bare string with no braces
 * is a plain column name.
 */
import { __testOnly as tenantCascadeTestOnly } from './tenantCascade';

export type OrgMergePolicy =
  | { kind: 'repoint' }
  | { kind: 'keep-survivor' } // singleton config: survivor row wins, loser's dropped
  | { kind: 'repoint-dedupe'; key: readonly string[]; keyWhere?: string } // drop loser rows colliding on key (within optional partial predicate), repoint the rest
  | { kind: 'custom'; note: string } // executor implemented in orgMerge.ts CUSTOM_EXECUTORS
  | { kind: 'leave-for-erasure'; note: string }
  | { kind: 'derived'; note: string } // trigger-maintained; never written directly
  | { kind: 'follows-parent'; note: string } // no org_id column; rows travel with their parent
  | { kind: 'loser-shell' } // organizations itself
  | { kind: 'blocks-merge'; note: string }; // rows FORBID the merge outright; engine refuses pre-walk — see specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md

// device_commands / user_sso_identities / sso_sessions / psa_ticket_mappings /
// deployment_results / software_versions / report_runs have no org_id column
// of their own:
// tenancy is inferred by joining to a parent row, so once the parent's
// org_id is repointed these rows travel along for free — the merge engine
// does nothing to them directly. (Exception: `report_runs` rows under a
// DUPLICATE narrative definition are re-homed by the `mergeReports` custom
// executor before the repoint; the rest still just travel with their parent.)
//
// These names are NOT retyped here: they're derived below from
// tenantCascade's ASSOCIATED_SYSTEM_SCOPED_TABLES (its FK pre-clear list for
// org erasure — tenantCascade.ts:1113 `__testOnly` re-export), so this
// registry can't silently drift from that list if it's ever extended.
//
// `software_deployments` is ALSO in ASSOCIATED_SYSTEM_SCOPED_TABLES (for an
// unrelated erasure-ordering reason — see tenantCascade.ts) but is EXCLUDED
// here: verified against src/db/schema/software.ts:83, it has its own
// NOT NULL org_id column (and is separately registered in
// CORE_ORG_CASCADE_DELETE_ORDER, tenantCascade.ts:325) with no trigger
// keeping it in sync. Classifying it follows-parent would mean the merge
// engine never touches its org_id, silently pinning those rows to the dead
// loser org forever — CORRECTED to a plain repoint in REPOINT_TABLES below.
const FOLLOWS_PARENT_NOTES: Readonly<Record<string, string>> = {
  device_commands: 'device-keyed',
  user_sso_identities: 'user-keyed',
  sso_sessions: 'provider-keyed',
  psa_ticket_mappings: 'connection/alert/device-keyed',
  deployment_results: 'deployment-keyed',
  software_versions: 'parent-keyed (software_catalog)',
  report_runs: 'parent-keyed (reports)',
};
const FOLLOWS_PARENT_OWN_ORG_ID_EXCEPTIONS = new Set(['software_deployments']);

/**
 * ASSOCIATED_SYSTEM_SCOPED_TABLES entries this registry deliberately does NOT
 * classify, because the merge engine could never reach them: the walk iterates
 * `topologicalCascadeOrder()`, which only contains tables in
 * `getOrgCascadeDeleteOrder()`. A table with no `org_id` column that is also
 * not FK-reachable from one gets no policy dispatch at all, so registering a
 * `custom` policy for it would be a dead entry that reads as coverage.
 *
 * These are handled by `runPostPassFixups` in orgMerge.ts instead — the same
 * place `config_policy_assignments` (also polymorphic: level/target_id, no
 * org_id) is handled, for exactly the same reason.
 */
const POST_PASS_FIXUP_TABLES = new Set(['accounting_entity_mappings']);

function buildFollowsParentEntries(): Record<string, OrgMergePolicy> {
  const entries: Record<string, OrgMergePolicy> = {};
  for (const { table } of tenantCascadeTestOnly.ASSOCIATED_SYSTEM_SCOPED_TABLES) {
    if (FOLLOWS_PARENT_OWN_ORG_ID_EXCEPTIONS.has(table)) continue;
    if (POST_PASS_FIXUP_TABLES.has(table)) continue;
    const note = FOLLOWS_PARENT_NOTES[table];
    if (!note) {
      // tenantCascade.ts gained a new ASSOCIATED_SYSTEM_SCOPED_TABLES entry
      // that this registry hasn't classified yet. Fail loudly rather than
      // silently leaving it unclassified (the contract test would also
      // catch this, but only if the table isn't otherwise in REPOINT_TABLES).
      throw new Error(
        `orgMergeRegistry: ASSOCIATED_SYSTEM_SCOPED_TABLES gained '${table}' with no follows-parent note — classify it in orgMergeRegistry.ts (verify first whether it has its own org_id column, like software_deployments does)`,
      );
    }
    entries[table] = { kind: 'follows-parent', note };
  }
  return entries;
}

const SPECIAL: Record<string, OrgMergePolicy> = {
  organizations: { kind: 'loser-shell' },

  // Track A durable authorization bindings copy both the automation owner and
  // the resource owner observed at admission. A plain org_id repoint leaves
  // expected_resource_org_id naming the loser and the deferred
  // automation_resource_bindings_expected_tenant_chk rejects the transaction.
  // The custom executor advances both axes together; partner-owned/system
  // bindings have a NULL expected_resource_org_id and remain unchanged.
  automation_resource_bindings: { kind: 'custom', note: 'repoint org_id and an org-owned expected_resource_org_id together so the durable authorization binding remains valid after the parent automation moves' },

  // Append-only (BEFORE UPDATE triggers RAISE unconditionally; per-org hash chain):
  audit_logs: { kind: 'leave-for-erasure', note: 'append-only + per-org hash chain; rows die with the loser shell' },
  audit_log_chain: { kind: 'leave-for-erasure', note: 'genesis-row unique per org' },
  audit_chain_anchors: { kind: 'leave-for-erasure', note: 'append-only' },
  ml_feedback_events: { kind: 'leave-for-erasure', note: 'append-only' },
  // agent_rollback_events (#4371 fixup): breeze_app has UPDATE, DELETE,
  // TRUNCATE revoked by migrations/2026-09-13-agent-rollback-lifecycle.sql,
  // and breeze_audit_admin only gets DELETE for retention — the same
  // privilege topology as ml_feedback_events above, so no role the merge
  // could assume can issue the repoint UPDATE. Before #4371,
  // ensureAppRole.ts's blanket per-boot GRANT silently re-permitted UPDATE
  // on this table (a gap that predated this table's own migration, not
  // caused by it), which is what let REPOINT_TABLES membership work by
  // accident; #4371 closed that gap, which is the correct fix — this entry
  // reclassifies the merge side to match, rather than reopening the
  // privilege hole to keep working around it.
  //
  // Note the append-only trigger (agent_rollback_events_append_only) DOES
  // special-case a same-org-as-device org_id-only UPDATE as a "trusted
  // restamp" — but that branch is presently unreachable by any role able to
  // even attempt the UPDATE, so it isn't a live repoint path today; wiring
  // one up (e.g. a SECURITY DEFINER restamp function) is a separate,
  // deliberate follow-up, not something to back into via this fix.
  agent_rollback_events: { kind: 'leave-for-erasure', note: 'append-only rollback evidence; breeze_app has no UPDATE (and breeze_audit_admin has none either) — rows die with the loser shell, same as ml_feedback_events' },

  // peripheral_policy_delivery_events (#4806 fixup): breeze_app has UPDATE,
  // DELETE, TRUNCATE revoked by migrations/2026-10-08-100800-peripheral-
  // policy-delivery-events-revoke-update.sql, and breeze_audit_admin only
  // gets SELECT/DELETE (INSERT/UPDATE/TRUNCATE revoked in the table's own
  // migrations/2026-09-11-peripheral-effective-policy-v2.sql) — the same
  // privilege topology as agent_rollback_events immediately above, so no
  // role the merge could assume can issue the repoint UPDATE. Before #4806,
  // breeze_app's real UPDATE grant (deliberately kept so moveOrg.ts could
  // restamp org_id) is what let REPOINT_TABLES membership work; #4806
  // revoked that grant because the restamp is redundant with the
  // breeze_cascade_device_org_id() SECURITY DEFINER trigger (see
  // DEVICE_ORG_FK_CASCADE_TABLES in routes/devices/core.ts), so this entry
  // reclassifies the merge side to match, rather than reopening the
  // privilege hole to keep working around it.
  //
  // The append-only trigger (peripheral_policy_delivery_events_append_only)
  // DOES special-case a same-org-as-device org_id-only UPDATE as a "trusted
  // restamp" — but, same as agent_rollback_events, that branch is presently
  // unreachable by any role able to even attempt the UPDATE, so it isn't a
  // live repoint path today; wiring one up is a separate, deliberate
  // follow-up, not something to back into via this fix.
  peripheral_policy_delivery_events: { kind: 'leave-for-erasure', note: 'append-only delivery evidence; breeze_app has no UPDATE (and breeze_audit_admin has none either) — rows die with the loser shell, same as agent_rollback_events' },

  // Column-level immutability: a BEFORE UPDATE row trigger RAISEs when
  // `org_id` changes, so these cannot be re-tenanted by ANY role the merge
  // can assume (the triggers are `tgenabled = 'O'`, and both bypasses —
  // `ALTER TABLE ... DISABLE TRIGGER` and `session_replication_role =
  // 'replica'` — need table ownership / superuser, neither of which
  // `breeze_app` has). `leave-for-erasure` is not a preference here, it is
  // the only physically reachable classification. The preview counts these
  // rows as destroyed, so the operator is told before the merge runs.
  // Enforced by the `no org_id-mutating policy sits on a table whose org_id
  // a trigger blocks` contract test.
  //
  // action_intents: PRE-EXISTING MISCLASSIFICATION, not rebase fallout — it
  // was `repoint-dedupe` (keyed on the real `action_intents_org_idem_uniq`
  // index), but `action_intents_block_content_update()` has listed `org_id`
  // in its immutable set since the table shipped
  // (migrations/2026-07-18-action-intents.sql, re-asserted verbatim by the
  // three later CREATE OR REPLACE migrations through 2026-09-05-a). The
  // repoint UPDATE raises `action_intents content is immutable` and aborts
  // the entire merge the moment the loser org holds a single intent; the
  // Wave-2 gauntlet never caught it because its fixture creates none.
  action_intents: { kind: 'leave-for-erasure', note: 'org_id is trigger-immutable (action_intents_block_content_update, since 2026-07-18) — a repoint raises and aborts the merge; durable approval records die with the loser shell' },
  // ai_agent_runs: org_id joined the immutable set in
  // migrations/2026-09-06-a-agent-runs-org-immutable.sql, which also encodes
  // the owner decision it exists for (2026-08-23): agent-run history stays
  // with the SOURCE org rather than following the device/org it was moved
  // from. Leaving it for erasure is that same decision applied to a merge.
  // This also keeps the composite
  // action_intents(requesting_agent_run_id, org_id) -> ai_agent_runs(id, org_id)
  // FK self-consistent: intents and runs stay together under the loser and
  // are erased together (tenantCascade deletes action_intents first —
  // alphabetical order happens to be the correct child-before-parent order).
  ai_agent_runs: { kind: 'leave-for-erasure', note: 'org_id is trigger-immutable (ai_agent_runs_immutable_guard); run history stays with the source org per the 2026-08-23 owner decision' },
  // ai_alert_verdicts (Phase 2 wave P2-1, #4187): hangs off a run that
  // itself stays with the source org (ai_agent_runs disposition above) —
  // same reasoning, not a separate immutability trigger.
  ai_alert_verdicts: { kind: 'leave-for-erasure', note: 'verdicts hang off ai_agent_runs (leave-for-erasure) and cascade with them; alert/group FKs cascade too' },
  // ai_agent_schedules (Phase 2 wave P2-2, #4189): dual-owner (org_id XOR
  // partner_id) config, same "not a normal org_id table" shape as ai_agents
  // above. An org override only makes sense against the LOSER org's own
  // partner-baseline relationship; the survivor keeps whatever override it
  // already has (or none, falling back to the baseline). Partner baseline
  // rows have org_id NULL and are never touched by an org merge at all.
  ai_agent_schedules: { kind: 'leave-for-erasure', note: 'org override rows tighten a partner baseline for the LOSER org only; the survivor keeps its own overrides. Partner rows have org_id NULL and are not merge participants.' },
  // ai_agent_fix_watches (Wave 6 PR 2, #3828): a fix-held watch is per-run
  // HISTORY tied to a specific ai_agent_runs row that itself never follows
  // an org merge (see ai_agent_runs above) — repointing the watch while its
  // run stays under the loser shell would split one remediation's story
  // across two orgs. Same composite (org_id, partner_id) FK fragility as
  // llm_egress_events/ai_unattended_exposure applies too.
  ai_agent_fix_watches: { kind: 'leave-for-erasure', note: 'watch history is tied to a run that itself stays with the source org (ai_agent_runs disposition); composite (org_id, partner_id) FK also makes a bare org_id repoint fragile — rows die with the loser shell' },
  // ai_agent_graduation (P2-5, #4192): derived history — a colon-key's
  // promotion journey is computed from ai_agent_op_evidence rows that are
  // themselves tied to runs which stay with the source org (ai_agent_runs
  // disposition above). Repointing the graduation row while its evidence
  // stays under the loser shell would split one key's story across two
  // orgs, same reasoning as ai_agent_fix_watches immediately above.
  ai_agent_graduation: { kind: 'leave-for-erasure', note: 'graduation state is derived from evidence tied to runs that stay with the source org (ai_agent_runs disposition); rows die with the loser shell rather than repoint into a story the evidence cannot follow' },
  ai_agent_impact_daily: { kind: 'leave-for-erasure', note: 'derived per-org daily rollup of runs/verdicts/watches that all themselves stay with the loser org (ai_agent_runs disposition) — repointing would double-count the survivor and nothing can regenerate under it; rows die with the loser shell' },
  // ai_agent_op_evidence (P2-5, #4192): each row is a historical copy of a
  // single terminal outcome (an intent, a watch verdict, an act execution,
  // a verdict vote) tied to a run/watch that itself stays with the source
  // org — same "history stays put" decision as ai_agent_fix_watches /
  // ai_agent_runs above, not a separate call.
  ai_agent_op_evidence: { kind: 'leave-for-erasure', note: 'evidence rows are historical copies of outcomes tied to runs/watches that stay with the source org (ai_agent_runs disposition); rows die with the loser shell' },
  // ticket_drafts (P2-4, #4191): CUSTOM, not leave-for-erasure — the row
  // must not survive INTO the merge, or `tickets`' own `repoint` aborts it.
  //
  // `tickets` is a plain `repoint`: `UPDATE tickets SET org_id = survivor
  // WHERE org_id = loser` runs unconditionally in the move phase, for every
  // ticket the loser org owns. `ticket_drafts_ticket_org_fk (ticket_id,
  // org_id) -> tickets(id, org_id)` requires a draft's org_id to match its
  // ticket's org_id. `leave-for-erasure` is a no-op during the merge itself
  // (rows are only actually destroyed later, when the loser org shell is
  // erased) — so a loser-org draft sits untouched with org_id = loser while
  // the tickets repoint just changed ITS ticket's org_id to survivor. The
  // instant that happens the FK's two legs disagree, and — now that this
  // constraint is DEFERRABLE INITIALLY IMMEDIATE (org-lifecycle contract) —
  // that disagreement raises 23503 immediately rather than waiting for
  // COMMIT, aborting the whole merge the moment the loser org holds a
  // single ticket with a draft. This is NOT about ticket_drafts_run_org_fk /
  // ticket_drafts_intent_org_fk (those legs are fine: run_id/intent_id stay
  // NULL-safe because MATCH SIMPLE never checks a NULL column, and neither
  // ai_agent_runs nor action_intents ever repoint, so there's no org_id
  // drift on that side to detect) — it is specifically the ticket_org_fk
  // leg, driven by `tickets` repointing out from under it.
  //
  // Fix: classify `custom` with a RESOLVE-phase executor
  // (`resolveTicketDrafts`, orgMergeCustomExecutors.ts) that DELETEs every
  // loser-org ticket_drafts row before ANY table's `move` phase runs (the
  // walk completes `resolve` for every table before starting `move` on any
  // — see `MergePolicyPhase` in orgMerge.ts), so by the time `tickets`
  // repoints, no draft is left to disagree with it. Drafts are ephemeral AI
  // proposals awaiting human approval (not the ticket_comments row itself),
  // so losing an in-flight draft in an org merge is acceptable — a fresh
  // triage run under the surviving organization regenerates one. The `move`
  // half is a no-op (resolve already leaves zero rows).
  ticket_drafts: { kind: 'custom', note: 'resolve-phase DELETE of every loser-org row before tickets repoints (its ticket_org_fk composite FK would otherwise 23503 the moment tickets moves org_id out from under a draft) — drafts are ephemeral AI proposals, not the durable ticket_comments record, so dropping them is acceptable; see orgMergeCustomExecutors.ts resolveTicketDrafts/moveTicketDrafts' },
  // ai_agent_circuit_state (Wave 6 PR 2, #3828): per-(org_id, agent_id)
  // failure-streak STATE, not a config row to carry forward — repointing
  // would let a loser org's failure streak silently open (or mask) a
  // circuit for an agent now living in the survivor org, attributing one
  // org's reliability history to another. Same composite (org_id,
  // partner_id) FK fragility as the tables above. The PRIMARY KEY is
  // (org_id, agent_id) itself, so there is no single-column org_id repoint
  // available anyway — the row would need to be reinserted under the new
  // key, i.e. a fresh circuit, which is exactly what closed+erased achieves.
  ai_agent_circuit_state: { kind: 'leave-for-erasure', note: 'per-org failure-streak state, not carried config; composite (org_id, partner_id) FK also makes a bare org_id repoint fragile — rows die with the loser shell' },
  // llm_egress_events (#3922 phase 2, landed on main 2026-08-27): per-request
  // egress telemetry — which org attempted which outbound LLM dial, allowed or
  // blocked. Repointing would attribute the loser org's egress history to the
  // survivor (and the composite (org_id, partner_id) FK to organizations means
  // an org_id-only UPDATE breaks the moment the two orgs' partners differ).
  // Same disposition as ai_agent_runs: history stays with the source org and
  // dies with the loser shell; the preview discloses the row count.
  llm_egress_events: { kind: 'leave-for-erasure', note: 'egress telemetry is per-org history; composite (org_id, partner_id) FK also makes a bare org_id repoint fragile — rows die with the loser shell' },
  // ai_unattended_exposure (Wave 5 Part A, #3827): the blast-cap reservation
  // ledger shared by the act lane and the policy-decide lane. Same
  // disposition as llm_egress_events for the same two reasons: it is
  // per-org exposure HISTORY (repointing would attribute the loser org's
  // unattended-action count to the survivor, corrupting the cap it exists
  // to enforce), and it carries the identical composite (org_id, partner_id)
  // FK to organizations, so a bare org_id UPDATE breaks the moment the two
  // orgs' partners differ. No writer exists yet in this PR either way.
  ai_unattended_exposure: { kind: 'leave-for-erasure', note: 'unattended-exposure history is per-org (like llm_egress_events); composite (org_id, partner_id) FK also makes a bare org_id repoint fragile — rows die with the loser shell' },

  // Durable PAM actuation evidence (Track E org-merge contract,
  // specs/2026-08-31-s0-track-e-pam-org-merge-contract-design.md): never
  // re-tenanted, never destroyed, never bypassed — a loser org holding ANY
  // row is refused outright. Repoint is physically unreachable
  // (pam_actuation_results: UPDATE revoked from breeze_app + unconditional
  // 42501 trigger; the composite (id, org_id) FK chain has no ON UPDATE
  // CASCADE), and leave-for-erasure would break
  // pam_actuations(device_id, org_id) -> devices(id, org_id) the moment the
  // devices repoint runs — which devices_pam_history_move_guard RAISEs 23514
  // on anyway. The engine refuses BEFORE the walk (collectMergeBlockers), so
  // neither trigger can fire mid-merge.
  pam_actuations: { kind: 'blocks-merge', note: 'durable PAM lifecycle evidence is source-frozen; any loser row refuses the merge — devices_pam_history_move_guard applied at org granularity' },
  pam_actuation_results: { kind: 'blocks-merge', note: 'append-only PAM evidence (UPDATE revoked + unconditional RAISE); cannot exist without a pam_actuations parent — listed for registry completeness and preview counting' },

  // partner_export_configuration_org_state is trigger-maintained (SECURITY
  // DEFINER triggers on the policy tables regenerate it — verified in
  // migrations/2026-07-25-partner-export-canonical-configuration.sql);
  // breeze_app has DML revoked on all three tables in this group.
  partner_export_configuration_org_state: { kind: 'derived', note: 'SECURITY DEFINER triggers regenerate as parents move' },
  // CORRECTED (review): these two move via their own composite FK, NOT a
  // trigger. Verified in
  // migrations/2026-07-23-partner-export-material-state-hardening.sql:
  // partner_export_device_material_state_device_org_fk (device_id, org_id)
  // -> devices(id, org_id) ON UPDATE CASCADE (and the site-keyed twin). When
  // the merge engine repoints devices.org_id / sites.org_id, Postgres
  // cascades org_id here for free — the merge engine never touches either
  // table directly.
  partner_export_device_material_state: { kind: 'derived', note: 'org_id moves via the (device_id, org_id) -> devices(id, org_id) ON UPDATE CASCADE FK, not trigger regeneration' },
  partner_export_site_material_state: { kind: 'derived', note: 'org_id moves via the (site_id, org_id) -> sites(id, org_id) ON UPDATE CASCADE FK, not trigger regeneration' },

  // Track B durable evidence (fix round 1 of Task 3, S0 Track B port,
  // 2026-08-31): the same physical shape as partner_export_device_material_state
  // above — org_id moves via the (device_id, org_id) -> devices(id, org_id)
  // ON UPDATE CASCADE FK, not a direct UPDATE. Originally misclassified
  // `repoint`: the contract test connects as the schema owner, so it never
  // caught that `breeze_app` has UPDATE (and TRUNCATE) REVOKEd on both
  // tables in their own append-only-evidence migrations
  // (2026-09-28-100000-agent-health-observations.sql,
  // 2026-09-28-100002-software-inventory-observations.sql) — `repoint`'s
  // unconditional `UPDATE ... SET org_id` as breeze_app would have raised
  // 42501 mid-merge, after the loser org was already fenced.
  agent_health_observations: { kind: 'derived', note: 'org_id moves via the (device_id, org_id) -> devices(id, org_id) ON UPDATE CASCADE FK; UPDATE is revoked from breeze_app (append-only evidence)' },
  software_inventory_observations: { kind: 'derived', note: 'org_id moves via the (device_id, org_id) -> devices(id, org_id) ON UPDATE CASCADE FK; UPDATE is revoked from breeze_app (append-only evidence)' },

  // No org_id column — tenancy via parent rows, which we re-point:
  ...buildFollowsParentEntries(),

  // Singleton config rows (UNIQUE(org_id)) — survivor's config wins:
  ai_budgets: { kind: 'keep-survivor' }, // verified: ai_budgets.org_id UNIQUE (ai.ts)
  portal_branding: { kind: 'keep-survivor' }, // verified: portal_branding.org_id UNIQUE (portal.ts)
  org_ticket_settings: { kind: 'keep-survivor' }, // verified: org_ticket_settings.org_id UNIQUE (ticketConfig.ts)
  pam_org_config: { kind: 'keep-survivor' }, // verified: pam_org_config_org_id_unique (pam.ts)
  client_ai_org_policies: { kind: 'keep-survivor' }, // verified: client_ai_org_policies_org_uniq (clientAi.ts)
  client_ai_tenant_mappings: { kind: 'keep-survivor' }, // verified: client_ai_tenant_mappings_org_uniq; also UNIQUE(entra_tenant_id): two different tenants can't both map to survivor
  google_workspace_connections: { kind: 'keep-survivor' }, // verified: google_workspace_connections_org_uniq (google.ts)
  user_risk_policies: { kind: 'keep-survivor' }, // verified: user_risk_policy_org_idx (userRisk.ts)

  // Unique-key tables — drop loser rows that would collide, move the rest:
  m365_connections: { kind: 'repoint-dedupe', key: ['profile'] }, // verified: m365_connections_org_profile_uniq (org_id, profile)
  tenant_variables: { kind: 'repoint-dedupe', key: ['key'] }, // verified: tenant_variables_org_key_uniq (org_id, key) WHERE org_id IS NOT NULL — trivially true for org-scoped rows
  catalog_item_org_pricing: { kind: 'repoint-dedupe', key: ['catalog_item_id'] }, // verified: catalog_item_org_pricing_item_org_uq (catalog_item_id, org_id)
  ticket_form_org_links: { kind: 'repoint-dedupe', key: ['form_id'] }, // verified: ticket_form_org_links_form_org_uq (form_id, org_id)
  oauth_client_blocks: { kind: 'repoint-dedupe', key: ['client_id'] }, // verified: oauth_client_blocks_org_client_uniq (org_id, client_id) — migrations/2026-05-07, not in Drizzle schema
  sso_verified_domains: { kind: 'repoint-dedupe', key: ['domain'] }, // verified: sso_verified_domains_org_domain_idx (org_id, domain)
  alert_correlation_groups: { kind: 'repoint-dedupe', key: ['group_key'] }, // verified: alert_correlation_groups_org_key_uq (org_id, group_key)
  ai_cost_usage: { kind: 'repoint-dedupe', key: ['period', 'period_key'] }, // verified: ai_cost_usage_org_period_idx (org_id, period, period_key)
  ai_budget_alert_events: { kind: 'repoint-dedupe', key: ['period', 'period_key', 'threshold_pct'] }, // verified: ai_budget_alert_events_org_period_rung_uidx (org_id, period, period_key, threshold_pct)
  client_ai_usage: { kind: 'repoint-dedupe', key: ['client_user_id', 'period', 'period_key'] }, // verified: client_ai_usage_bucket_uniq (org_id, client_user_id, period, period_key)
  contact_external_links: { kind: 'repoint-dedupe', key: ['system', 'external_id'] }, // verified: contact_external_links_uniq (org_id, system, external_id)
  delegant_m365_connections: { kind: 'repoint-dedupe', key: ['customer_label'] }, // verified: delegant_m365_org_customer_uniq (org_id, customer_label)
  remediation_suggestions: { kind: 'repoint-dedupe', key: ['source_type', 'source_id'] }, // superset of its four partial uniques (org_id, source_type, source_id, {script_id|script_template_id|playbook_id|target_type}); derived rows, over-dropping is safe
  tunnel_allowlists: { kind: 'repoint-dedupe', key: ['direction', 'pattern', "COALESCE({site_id}, '00000000-0000-0000-0000-000000000000'::uuid)"] }, // verified: tunnel_allowlists_org_direction_pattern_site_idx (2026-08-08-proxy-session-lifetime.sql)
  // action_intents used to be classified here as a `repoint-dedupe` keyed on
  // action_intents_org_idem_uniq. It is now `leave-for-erasure` above: the
  // index reading was right, but org_id is trigger-immutable so no repoint
  // can run at all. See the note there.
  device_mtls_certificates: { kind: 'repoint-dedupe', key: ['serial_number'] }, // verified: device_mtls_certificates_org_serial_uq (org_id, serial_number)
  // CORRECTED (controller ruling R1): was a plain repoint, but
  // user_risk_org_user_calc_idx is a TOTAL unique on (org_id, user_id,
  // calculated_at) and user_id is the SAME person across both orgs — a user
  // scored in both orgs at the same instant would raise 23505 and abort the
  // whole merge. This is the only plain-repoint table whose org-scoped unique
  // is not disambiguated by an org-specific column (devices/sites/ids); the
  // other 18 hits from the catalog sweep are safe by construction.
  user_risk_scores: { kind: 'repoint-dedupe', key: ['user_id', 'calculated_at'] },

  // Hand-written executors (Task 3):
  //
  // CORRECTED (final review): the five entries immediately below were all
  // `repoint-dedupe`, whose generic DELETE aborts the ENTIRE merge with 23503
  // the moment a colliding loser row has a child. Verified against
  // `pg_constraint` on a live database rather than the Drizzle models — the
  // sweep and its full output are recorded in
  // `.superpowers/sdd/2026-08-26-org-lifecycle-w2-merge-engine/task-8-fixwave.md`.
  // Every inbound FK below is NON-deferrable, so `SET CONSTRAINTS ALL DEFERRED`
  // does not help; the reference has to be moved off the doomed row first.
  //
  //   discovered_assets    <- network_monitors.asset_id, snmp_devices.asset_id,
  //                           unifi_clients/unifi_devices/unifi_device_telemetry
  //                           .discovered_asset_id            (5x NO ACTION)
  //   plugin_installations <- plugin_logs.installation_id     (NO ACTION, NOT NULL)
  //   playbook_definitions <- playbook_executions.playbook_id (NO ACTION, NOT NULL)
  //   pam_signer_groups    <- pam_rules.match_signer_group_id (ON DELETE RESTRICT)
  //   reports              <- report_runs.report_id           (NO ACTION, NOT NULL)
  //   incidents            <- incident_actions.incident_id,
  //                           incident_evidence.incident_id   (2x NO ACTION, NOT NULL)
  //
  // The first five re-home their children onto the SURVIVOR's row and then
  // delete the now-unreferenced duplicate. `incidents` does not delete at all
  // (see its note) — an incident is a case file, not a derived row.
  discovered_assets: { kind: 'custom', note: 're-home network_monitors/snmp_devices/unifi_* children onto the survivor asset with the same ip_address, then delete the duplicate; SPLIT across phases because discovered_assets rides sites\' ON UPDATE CASCADE (see CUSTOM_RESOLVE_EXECUTORS)' },
  plugin_installations: { kind: 'custom', note: 're-home plugin_logs.installation_id onto the survivor installation for the same catalog_id, then delete the duplicate' },
  playbook_definitions: { kind: 'custom', note: 're-home playbook_executions.playbook_id (and remediation_suggestions.playbook_id) onto the survivor definition with the same lower(name), then delete the duplicate' },
  pam_signer_groups: { kind: 'custom', note: 're-home pam_rules.match_signer_group_id onto the survivor group with the same name, then delete the duplicate (the FK is ON DELETE RESTRICT — a plain dedupe DELETE raises 23503)' },
  // CORRECTED (P2-3 review, #4190): `reports` was a plain `repoint` — correct
  // until P2-3 gave it its FIRST collidable unique index,
  // `reports_source_ai_agent_schedule_uniq (org_id, source_ai_agent_schedule_id)
  // WHERE source_ai_agent_schedule_id IS NOT NULL`. A PARTNER-WIDE narrative
  // schedule mints one definition per org, so merging two orgs under the same
  // partner repoints both onto `(survivor, same schedule)` -> 23505, and the
  // whole merge aborts. `repoint-dedupe` cannot fix it either: its DELETE hits
  // `report_runs.report_id` (NO ACTION, NOT NULL, non-deferrable — verified
  // against pg_constraint) and raises 23503 instead. Same shape as
  // plugin_installations/plugin_logs, so the same remedy.
  //
  // Narrative definitions dedupe by non-NULL source_ai_agent_schedule_id.
  // Portal self-service definitions have a second pass keyed by type and
  // explicitly restricted to portal_self_service=true on both sides, so
  // ordinary reports of the same type remain independent.
  reports: { kind: 'custom', note: "dedupe narrative-schedule definitions by source_ai_agent_schedule_id and portal-self-service definitions by type; in both passes re-home report_runs.report_id, dedupe report_schedule_recipients by (report_id, contact_id), and re-home remaining recipients before deleting duplicate definitions; NEVER delete report runs or recipient rows except recipient-key collisions" },
  incidents: { kind: 'custom', note: "NULL the colliding loser row's source_ref (it leaves the incidents_source_ref_unique partial index, which is WHERE source_ref IS NOT NULL) and record the old value in `summary`; NEVER delete — incident_actions/incident_evidence are NOT NULL NO ACTION children and an incident is a case file, not a derived row" },
  contacts: { kind: 'custom', note: 'clear loser is_primary if survivor has one, then repoint (partial unique)' },
  backup_configs: { kind: 'custom', note: 'clear loser is_default if survivor has one, then repoint (org-owned storage creds must NOT be dropped)' },
  audit_baselines: { kind: 'custom', note: 'deactivate (is_active=false) colliding active baselines; NEVER DELETE — audit_baseline_results and audit_baseline_apply_approvals are ON DELETE CASCADE' },
  pax8_orders: { kind: 'custom', note: 'delete loser direct draft/awaiting orders colliding with survivor partial unique, repoint rest' },
  // CORRECTED (review): repoint-dedupe would DELETE colliding loser
  // findings, but fleet_remediation_runs (finding_id, org_id) ->
  // fleet_findings(id, org_id) ON DELETE CASCADE and
  // fleet_finding_devices.finding_id -> fleet_findings.id ON DELETE CASCADE
  // both hang off fleet_findings.id — deleting a loser finding silently
  // wipes its remediation-run history and live device membership. Verified
  // both FKs in migrations/2026-08-16-fleet-hygiene-findings.sql.
  fleet_findings: { kind: 'custom', note: 'set resolved_at on colliding loser findings (removes them from the fleet_findings_live_episode_uq partial index WHERE resolved_at IS NULL) — NEVER delete: fleet_remediation_runs/fleet_finding_devices cascade; then repoint all rows' },
  // CORRECTED (review): repoint-dedupe would DELETE the loser row outright
  // on a (user_id, role_id) collision, silently discarding its site_ids /
  // device_group_ids arrays (per-org access scoping) instead of carrying
  // that access forward to the survivor.
  organization_users: { kind: 'custom', note: "union the loser row's site_ids/device_group_ids arrays into the surviving membership row, then delete the loser row" },
  // ai_agents — dual-owner config table (org_id XOR partner_id). Only the
  // org-owned rows are in merge scope; the partner-wide ones (org_id IS NULL)
  // are never touched, and their `ai_agents_partner_kind_uq` partial index
  // (WHERE org_id IS NULL AND disabled_at IS NULL) therefore cannot collide.
  //
  // `ai_agents_org_kind_uq ON (org_id, kind) WHERE disabled_at IS NULL` CAN
  // collide — both orgs may run an active agent of the same kind — so a plain
  // repoint raises 23505. A `repoint-dedupe` DELETE is not available either:
  // three inbound FKs are ON DELETE RESTRICT (ai_agent_runs.agent_id,
  // ai_sessions.agent_id, automations.managed_by_agent_id), and the loser's
  // ai_agent_runs are `leave-for-erasure` and therefore still referencing the
  // row at merge time. Neutralize instead, exactly as audit_baselines and
  // fleet_findings do.
  ai_agents: { kind: 'custom', note: "disable colliding loser agents (disabled_at=now(), enabled=false — the same write agentService.disableAgent makes) so they leave the ai_agents_org_kind_uq partial index, then repoint all rows; NEVER delete — ai_agent_runs/ai_sessions/automations are ON DELETE RESTRICT children" },
  // Controller ruling R2 (spec compliance): the design doc says the loser's
  // org-bound capabilities are "revoked, not repointed". Repointing alone
  // would silently hand the survivor a live credential the loser's contacts
  // still hold. These two repoint AND revoke through each table's ESTABLISHED
  // mechanism — api_keys.status='revoked' (mirroring
  // tenantLifecycle.revokeApiKeysForOrgIds) and enrollment_keys.expires_at=now()
  // (mirroring tenantLifecycle.expireEnrollmentKeysForOrgIds). No new columns.
  api_keys: { kind: 'custom', note: "revoke the loser's keys (status='revoked') BEFORE repointing so the survivor's own keys are never touched; counts surfaced as a merge warning" },
  enrollment_keys: { kind: 'custom', note: "expire the loser's keys (expires_at=now()) BEFORE repointing so the survivor's own keys are never touched; counts surfaced as a merge warning" },
};

// Every remaining cascade table: a plain org_id repoint, no dedup needed.
// GENERATED mechanically per the brief: SPECIAL was written first, the
// contract test was run, and its printed `missing` array (232 tables) was
// pasted in verbatim below. `users` (email globally unique — a person's one
// row simply moves) and `portal_users` (no email unique — nothing can
// collide) are deliberately here rather than in SPECIAL, per the brief.
// Same for vendor-mapping integration tables (huntress_org_mappings,
// s1_org_mappings, unifi_site_mappings, organization_external_links, etc.):
// they carry no org-scoped unique key, so after the merge the survivor simply
// holds BOTH orgs' mappings and there is nothing to dedupe or drop.
//
// CORRECTED (final review): an earlier version of this comment claimed the
// duplicates "surface in the merge summary". They do not, and the summary has
// no mechanism that could — it is keyed by table and carries only moved/dropped
// counts, so two mappings landing under one org are indistinguishable from two
// unrelated rows moving. `organization_external_links` is the ONE exception,
// and only because `collectDuplicates` (orgMerge.ts) runs an explicit
// `GROUP BY system HAVING count(*) > 1` for it; the huntress/s1/unifi mapping
// tables get no such pass and their duplicates are silent by design — a
// re-import may bind to either row.
const REPOINT_TABLES: readonly string[] = [
  "access_reviews",
  "account_deletion_requests",
  "agent_logs",
  "agent_rollback_directives",
  // agent_rollback_events removed (#4371 fixup): reclassified 'leave-for-erasure'
  // in SPECIAL above — breeze_app has no UPDATE on this append-only table.
  "ai_action_plans",
  "ai_screenshots",
  "ai_sessions",
  "alert_correlation_members",
  "alert_rules",
  "alert_templates",
  "alerts",
  "analytics_dashboards",
  "asset_checkouts",
  "audit_baseline_apply_approvals",
  "audit_baseline_results",
  "audit_policy_states",
  "audit_retention_policies",
  "automation_action_results",
  "automation_policies",
  "automation_run_device_results",
  "automations",
  "backup_chains",
  "backup_jobs",
  "backup_policies",
  "backup_profiles",
  "backup_sla_configs",
  "backup_sla_events",
  "backup_snapshots",
  "backup_verifications",
  "brain_device_context",
  "browser_extensions",
  "browser_policies",
  "browser_policy_violations",
  "c2c_backup_configs",
  "c2c_backup_items",
  "c2c_backup_jobs",
  "c2c_connections",
  "c2c_consent_sessions",
  "capacity_predictions",
  "capacity_thresholds",
  "cis_baseline_results",
  "cis_baselines",
  "cis_remediation_actions",
  "client_ai_prompt_templates",
  "config_policy_backup_settings",
  "config_policy_onedrive_libraries",
  "config_policy_onedrive_settings",
  "configuration_policies",
  "contract_billing_period_outcomes",
  "contract_billing_periods",
  "contract_documents",
  "contract_lines",
  "contract_renewal_notices",
  "contract_template_versions",
  "contract_templates",
  "contracts",
  "custom_field_definitions",
  "customer_email_domains",
  "deployment_invites",
  "deployments",
  "device_agent_health_latest",
  "device_boot_metrics",
  "device_change_log",
  "device_config_state",
  "device_connections",
  "device_disks",
  "device_event_logs",
  "device_filesystem_cleanup_runs",
  "device_filesystem_scan_state",
  "device_filesystem_snapshots",
  "device_group_memberships",
  "device_groups",
  "device_hardware",
  "device_ip_history",
  "device_link_groups",
  "device_metrics",
  "device_network",
  "device_patches",
  "device_process_samples",
  "device_recovery_keys",
  "device_registry_state",
  "device_reliability",
  "device_reliability_history",
  "device_sessions",
  "device_software_inventory_state",
  "device_vulnerabilities",
  "device_warranty",
  "devices",
  "discovery_jobs",
  "discovery_profiles",
  "dns_event_aggregations",
  "dns_filter_integrations",
  "dns_policies",
  "dns_security_events",
  "dr_executions",
  "dr_plan_groups",
  "dr_plans",
  "elevation_audit",
  "elevation_requests",
  "escalation_policies",
  // event_delivery_receipts (durable dispatch bookkeeping, #4117, landed on
  // main 2026-08-27 — the same PR dropped event_bus_events, which used to be
  // listed here): PK (event_id, subscriber_id) carries no org, so a repoint
  // can't collide, and in-flight planned/delivering receipts keep retrying
  // against the surviving org instead of a dead shell.
  "event_delivery_receipts",
  "executive_summaries",
  "fleet_finding_devices",
  "fleet_remediation_run_targets",
  "fleet_remediation_runs",
  "group_membership_log",
  "huntress_agents",
  "huntress_incidents",
  "huntress_integrations",
  "huntress_org_mappings",
  "hyperv_vms",
  "incident_actions",
  "incident_evidence",
  "installer_bootstrap_tokens",
  "invoice_documents",
  "invoice_line_devices",
  "invoice_lines",
  "invoice_payments",
  "invoice_stripe_payments",
  "invoices",
  "local_vaults",
  "log_correlation_rules",
  "log_correlations",
  "log_search_queries",
  "m365_consent_sessions",
  "maintenance_windows",
  "metric_anomalies",
  "metric_anomaly_candidates",
  "metric_anomaly_incidents",
  "metric_rollups",
  "metric_rollups_default",
  "network_baselines",
  "network_change_events",
  "network_monitors",
  "network_topology",
  "notification_channels",
  "notification_routing_rules",
  "oauth_authorization_codes",
  "oauth_grants",
  "oauth_refresh_tokens",
  "onedrive_device_state",
  "organization_external_links",
  "pam_rules",
  "partner_enrollment_key_idempotency",
  "patch_compliance_reports",
  "patch_compliance_snapshots",
  "patch_jobs",
  "pax8_company_mappings",
  "pax8_contract_line_links",
  "pax8_order_lines",
  "pax8_subscription_snapshots",
  "peripheral_events",
  "peripheral_policies",
  "peripheral_policy_device_states",
  "playbook_executions",
  "plugin_instances",
  "plugins",
  "portal_users",
  "provision_credential_handles",
  "psa_connections",
  "quote_acceptances",
  "quote_blocks",
  "quote_images",
  "quote_lines",
  "quote_order_lines",
  "quote_orders",
  "quote_recipients",
  "quotes",
  "recovery_boot_media_artifacts",
  "recovery_key_access_events",
  "recovery_media_artifacts",
  "recovery_readiness",
  "recovery_tokens",
  "remote_sessions",
  "report_schedule_recipients",
  // "reports" is SPECIAL (custom) — see its note there.
  "restore_jobs",
  "roles",
  "s1_actions",
  "s1_agents",
  "s1_integrations",
  "s1_org_mappings",
  "s1_site_mappings",
  "s1_threats",
  "saved_filters",
  "saved_queries",
  "script_categories",
  "script_execution_batches",
  "script_executions",
  "script_tags",
  "scripts",
  "security_policies",
  "security_posture_org_snapshots",
  "security_posture_snapshots",
  "security_scans",
  "security_status",
  "security_threats",
  "sensitive_data_findings",
  "sensitive_data_policies",
  "sensitive_data_scans",
  "service_principals",
  "service_process_check_results",
  "sites",
  "sla_compliance",
  "sla_definitions",
  "snmp_devices",
  "snmp_metrics",
  "snmp_templates",
  "software_catalog",
  "software_deployments", // has its own org_id; see the note in SPECIAL for why this isn't follows-parent
  "software_inventory",
  "software_policies",
  "software_policy_audit",
  "software_remediation_requests",
  "software_upload_sessions",
  "sql_instances",
  "sso_providers",
  "storage_encryption_keys",
  "support_sessions",
  "ticket_alert_links",
  // W08 #3902. Own org_id (shape 1), so plain repoint like its siblings — the
  // only unique index is the pkey on `id`, which cannot collide across orgs,
  // so no dedupe key is needed. Pending rows (comment_id NULL) repoint too:
  // the claim predicate in addTicketComment matches on the ticket's org_id.
  "ticket_attachments",
  "ticket_email_links",
  "ticket_forms",
  "ticket_outbox",
  "ticket_parts",
  // #4524: a merge repoints tickets.org_id by direct SQL, so it changes a
  // ticket's org WITHOUT going through moveTicketOrg — which is where the
  // ai_agent_runs.ticket_id / ticket_comments.agent_run_id detach lives, and
  // there is no `UPDATE OF org_id ON tickets` trigger to back it up (the device
  // axis has breeze_cascade_device_org_id(); the ticket axis has nothing).
  // That is deliberate and safe HERE, unlike a cross-org ticket move: Phase A
  // fences the loser to status='merging' BEFORE this repoint runs, which drops
  // it out of accessibleOrgIds and every ingress gate, so no token can read a
  // loser-org run at all; and ai_agent_runs is `leave-for-erasure` above, so
  // those rows are destroyed with the loser shell in Phase C rather than
  // outliving it. Its ticket_id is also a plain single-column FK, so — unlike
  // ticket_drafts above — it can never 23503 the repoint. No custom executor
  // needed. If either premise ever changes (the loser stays readable, or
  // ai_agent_runs starts repointing), this entry needs one.
  "tickets",
  "time_entries",
  "time_series_metrics",
  "topology_layout",
  "topology_manual_nodes",
  "tunnel_sessions",
  "unifi_clients",
  "unifi_collectors",
  "unifi_controller_sites",
  "unifi_device_telemetry",
  "unifi_devices",
  "unifi_site_mappings",
  "user_notifications",
  "user_risk_events",
  "users",
  "vault_snapshot_inventory",
  "webhooks",
];

export function getOrgMergePolicies(): ReadonlyMap<string, OrgMergePolicy> {
  const map = new Map<string, OrgMergePolicy>(Object.entries(SPECIAL));
  for (const t of REPOINT_TABLES) {
    if (map.has(t)) {
      // SPECIAL and REPOINT_TABLES must be disjoint — a table gets exactly
      // one merge policy. Silently overwriting here (the old behavior)
      // would mask a real classification bug. The contract test's
      // disjointness assertion exercises this by calling
      // getOrgMergePolicies() and expecting it not to throw.
      throw new Error(
        `orgMergeRegistry: '${t}' is classified in both SPECIAL and REPOINT_TABLES — a table must have exactly one merge policy`,
      );
    }
    map.set(t, { kind: 'repoint' });
  }
  return map;
}

/**
 * Exposed for tests / introspection only (mirrors tenantCascade.ts's
 * __testOnly pattern) — lets the contract test assert SPECIAL and
 * REPOINT_TABLES are disjoint with a clear failure message instead of
 * relying solely on the constructor throw above.
 */
export const __testOnly = { SPECIAL, REPOINT_TABLES };
