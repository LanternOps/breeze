import { afterAll, describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { partners, users, organizations, sites, invoices, invoiceLines, invoiceDocuments, contracts, contractLines, contractBillingPeriods, mlFeedbackEvents, unifiCollectors, unifiDeviceTelemetry, unifiClients } from '../../db/schema';
import { approvalRequests } from '../../db/schema/approvals';
import { manifestSigningKeys } from '../../db/schema/manifestSigningKeys';
import { partnerAbuseSignals } from '../../db/schema/abuseSignals';
import { automations, automationRuns } from '../../db/schema/automations';
import { configurationPolicies } from '../../db/schema/configurationPolicies';
import { scripts, scriptExecutionBatches } from '../../db/schema/scripts';
import { unifiIntegrations, unifiDevices } from '../../db/schema/unifi';

/**
 * Contract test: every tenant-scoped public table must have RLS enabled and
 * must have at least one permissive policy per DML command (SELECT, INSERT,
 * UPDATE, DELETE) whose predicate references the appropriate access helper.
 * An ALL-cmd policy counts for all four.
 *
 * Five shapes of tenant-scoping are recognised, each with its own assertion:
 *   1. **org-tenant tables** — tables with an `org_id` column (auto-
 *      discovered) or where the row's own id is the tenant identifier
 *      (explicit list). Policies must reference `breeze_has_org_access`.
 *   2. **partner-tenant tables** — tables where the tenant is a partner:
 *      `partner_users.partner_id` or the partner row's own id. Policies
 *      must reference `breeze_has_partner_access`.
 *   3. **dual-axis tables** — `users` is keyed on BOTH partner_id AND
 *      org_id (OR'd in the policy), plus a self-read branch. Its four
 *      DML commands must be covered by policies that reference either
 *      `breeze_has_org_access` or `breeze_has_partner_access` (or both).
 *   4. **join-policy tables** — tables with a `device_id` FK but no
 *      denormalized `org_id`. Their policies join through `devices` via a
 *      subquery. Policies must contain both `FROM devices` and
 *      `breeze_has_org_access` in the predicate.
 *   5. **user-id-scoped tables** — tables scoped to the calling user via
 *      `breeze_current_user_id()`. Policies must reference
 *      `breeze_current_user_id` in the predicate.
 *
 * All shapes accept per-command policies (new) or a single ALL policy
 * (legacy migration 0008 shape). The test is semantic, not name-bound.
 */

// Tables that intentionally do not carry RLS isolation policies.
// Add deliberately, with a comment.
const EXEMPT_TABLES: ReadonlySet<string> = new Set<string>([
  // System-scoped: forced RLS with either no policies or a system-only
  // policy — in both cases only the system DB context can access the table.
  // See INTENTIONAL_UNSCOPED below for the documented set (some entries,
  // like partner_abuse_signals, DO have a tenant column but are
  // operator-only by design, not tenant-column-less).
  'manifest_signing_keys',
  'm365_consent_sessions',
  'partner_abuse_signals',
]);

// System-scoped tables: forced RLS with either no permissive policies at all,
// or a single system-only policy (`USING current_setting('breeze.scope',
// true) = 'system'`) — in both cases only the system DB context (which sets
// that GUC) can read/write, never the unprivileged breeze_app role under a
// tenant-scoped context. Some of these have no tenant column at all
// (per-deployment infrastructure); others (partner_abuse_signals) DO carry a
// tenant column (partner_id) but are deliberately operator-only, not
// tenant-readable, so they're listed here rather than under a tenant shape.
// The auto-discovery query won't surface these (no org_id column, not in any
// tenant list), but they are enumerated here for explicit documentation and
// so that a future "all-tables RLS enabled" audit can assert against this list.
//
// NOTE: device_commands is the canonical prior example (agent WS path, system-
// scoped by design) — see apps/api/src/db/schema/devices.ts.
const INTENTIONAL_UNSCOPED: ReadonlySet<string> = new Set<string>([
  'device_commands', // Agent WS path: system-scoped command queue, no tenant isolation needed.
  'intent_outbox', // Action intents transactional outbox (spec 2026-07-18): system-scoped, workers-only queue, no tenant isolation needed. FK-cascades from action_intents (org-scoped, RLS shape 1). Mirrors device_commands.
  'manifest_signing_keys', // System-scoped: per-deployment agent-update signing key. Forced RLS, no policies → only system context.
  'm365_consent_sessions', // OAuth consent state: forced RLS, system-only policies; tenant scopes must never read verifier/nonce material.
  'vulnerability_sources', // Global vulnerability-source sync metadata. Forced RLS, no tenant policies → only system context.
  'vulnerabilities', // Global vulnerability catalog. Forced RLS, no tenant policies → only system context.
  'software_products', // Global normalized software dimension. Forced RLS, no tenant policies → only system context.
  'software_vulnerabilities', // Global software-to-vulnerability match facts. Forced RLS, no tenant policies → only system context.
  'os_vulnerabilities', // Global OS-to-vulnerability match facts. Forced RLS, no tenant policies → only system context.
  'software_product_resolutions', // Global DisplayName→product resolution cache/log (#2290). Forced RLS, system-only policy → only system context.
  'third_party_package_catalog', // System-wide curated catalog of third-party packages; writes gated by platform-admin role at the route layer.
  'third_party_release_tests', // System-wide release test results; references catalog (unscoped) and is platform-admin-only at the route layer.
  'partner_abuse_signals', // Operator abuse signals ABOUT partners. Forced RLS, system-only policy — partners must never see their own risk signals.
  'sso_sessions', // Pre-auth SSO CSRF/PKCE transaction store (state/nonce/code_verifier + link binding). No tenant column; written/consumed only by unauthenticated callback + system-context routes. Forced RLS, system-only policy → only system context.
]);

// Tables with org_id metadata that are intentionally not generic org-tenant
// tables. OAuth token rows are user/client secrets; org_id is retained for
// lifecycle filtering only, and tenant-wide revocation uses system DB context
// after app-layer authorization.
const ORG_AXIS_POLICY_EXCLUDED_TABLES: ReadonlySet<string> = new Set<string>([
  'oauth_authorization_codes',
  'oauth_grants',
  'oauth_refresh_tokens',
  // account_deletion_requests: user-id scoped (Shape 6). The denormalised
  // org_id is retained for ops/audit attribution only; the RLS policy uses
  // breeze_current_user_id(), not breeze_has_org_access.
  'account_deletion_requests',
  // time_entries: partner-axis (Shape 3). org_id is denormalized from the
  // parent ticket at write time for filtering only — the RLS axis is
  // partner_id. Spec §8a / Phase 3 plan: deliberately no org/portal policies.
  'time_entries',
  // Huntress credentials and discovered-org mappings are partner-scoped.
  // org_id is retained only as legacy/mapping metadata and may be NULL for
  // quarantined Huntress orgs.
  'huntress_integrations',
  'huntress_org_mappings',
  // SentinelOne credentials and discovered-site mappings are partner-scoped.
  // org_id is retained only as legacy/mapping metadata and may be NULL.
  's1_integrations',
  's1_org_mappings',
  // Pax8 sync tables: partner-axis (Shape 3). The MSP partner owns the Pax8
  // integration; org_id is denormalized (nullable on mappings/snapshots, for the
  // resolved customer) for FK joins + filtering only — the RLS axis is partner_id
  // (breeze_has_partner_access, asserted via PARTNER_TENANT_TABLES). Without these
  // the org_id column makes auto-discovery treat them as shape-1 org-tenant and
  // demand breeze_has_org_access they intentionally don't have (#1594 added them
  // to PARTNER_TENANT_TABLES but missed this set). pax8_integrations /
  // pax8_product_mappings have no org_id, so they're never auto-discovered here.
  'pax8_company_mappings',
  'pax8_subscription_snapshots',
  'pax8_contract_line_links',
  // pax8_orders / pax8_order_lines (2026-07-13, ordering): same shape — org_id
  // is the customer the order is FOR, not the tenancy axis. Ordering is an
  // MSP-side act; an org-scoped token must never see one.
  'pax8_orders',
  'pax8_order_lines',
  // customer_email_domains (Phase 5): partner-axis (Shape 3) carrying a
  // denormalized org_id (the routing target). RLS axis is partner_id; the
  // org_id is for routing + cascade only. Functional cross-partner/cross-org
  // forge proof: customerEmailDomainsRls.integration.test.ts.
  'customer_email_domains',
  // ticket_form_org_links (2026-07-11): FK-child of the dual-axis ticket_forms
  // parent (Shape 5-adjacent, registered in PARENT_FK_JOIN_POLICY_TABLES
  // below). Its own org_id column is the ALLOWLISTED org, not the tenancy
  // axis — the loose `LIKE '%breeze_has_org_access%'` substring match in the
  // generic org-tenant test would otherwise spuriously "pass" this table
  // because the FK-join policy text does call breeze_has_org_access(tf.org_id)
  // (the PARENT's column), just not on this table's own org_id. Excluding it
  // here keeps that generic check honest; PARENT_FK_JOIN_POLICY_TABLES is the
  // real assertion for this table's policy shape.
  'ticket_form_org_links',
]);

// Tables whose own `id` column is the tenant identifier (no `org_id`).
const ORG_ID_KEYED_TENANT_TABLES: ReadonlySet<string> = new Set<string>([
  'organizations',
]);

// Tables in the partner tenancy axis. Each entry points at the column
// `breeze_has_partner_access` should be called with. `id` means "the row's
// own primary key is the partner id" (e.g. partners.id).
const PARTNER_TENANT_TABLES: ReadonlyMap<string, string> = new Map<string, string>([
  ['partners', 'id'],
  ['partner_users', 'partner_id'],
  ['oauth_clients', 'partner_id'],
  ['oauth_client_partner_grants', 'partner_id'],
  ['email_verification_tokens', 'partner_id'],
  ['ticket_categories', 'partner_id'],
  ['ticket_response_templates', 'partner_id'],
  ['ticket_mailbox_connections', 'partner_id'],
  ['ticket_mailbox_tenant_ownerships', 'partner_id'],
  ['ticket_mailbox_consent_sessions', 'partner_id'],
  ['partner_ticket_sequences', 'partner_id'],
  ['partner_invoice_sequences', 'partner_id'],
  ['partner_quote_sequences', 'partner_id'],
  ['ticket_statuses', 'partner_id'],
  ['ticket_priority_settings', 'partner_id'],
  ['time_entries', 'partner_id'],
  ['huntress_integrations', 'partner_id'],
  ['huntress_org_mappings', 'partner_id'],
  ['pax8_integrations', 'partner_id'],
  ['pax8_company_mappings', 'partner_id'],
  ['pax8_subscription_snapshots', 'partner_id'],
  ['pax8_product_mappings', 'partner_id'],
  ['pax8_contract_line_links', 'partner_id'],
  ['pax8_orders', 'partner_id'],
  ['pax8_order_lines', 'partner_id'],
  ['accounting_connections', 'partner_id'],
  ['scripts', 'partner_id'],
  ['script_categories', 'partner_id'],
  ['script_tags', 'partner_id'],
  ['alert_templates', 'partner_id'],
  // Product catalog (2026-06-14): partner-axis (RLS shape 3), flat
  // breeze_has_partner_access(partner_id) policies. catalog_bundle_components
  // denormalizes partner_id (rather than join through the bundle item) to
  // avoid the #1016 nested-EXISTS bound-param bug. catalog_item_org_pricing
  // is NOT here — it carries a direct org_id column and is auto-discovered
  // as an ordinary shape-1 org-tenant table.
  ['catalog_items', 'partner_id'],
  ['catalog_item_images', 'partner_id'],
  ['catalog_bundle_components', 'partner_id'],
  ['td_synnex_digital_bridge_integrations', 'partner_id'],
  ['td_synnex_ec_express_integrations', 'partner_id'],
  // Nightly SFTP P&A file ingest (2026-07-16): partner-axis (Shape 3).
  // td_synnex_price_availability holds the ingested rows and is written by the
  // nightly worker under a system context; both carry a flat partner_id.
  // Functional cross-partner forge proof: tdSynnexSftpRls.integration.test.ts.
  ['td_synnex_sftp_integrations', 'partner_id'],
  ['td_synnex_price_availability', 'partner_id'],
  // Phase 4 email-to-ticket ingest (Shape 3). partner_id is nullable on
  // ticket_email_inbound (only system scope may write null-partner rows);
  // NOT NULL on partner_inbound_domains. Policy:
  //   breeze_current_scope()='system' OR breeze_has_partner_access(partner_id)
  // Functional cross-partner forge proof: emailInboundRls.integration.test.ts.
  ['ticket_email_inbound', 'partner_id'],
  ['partner_inbound_domains', 'partner_id'],
  // customer_email_domains (Phase 5): sender-domain -> customer-org routing.
  // Partner-axis + denormalized org_id (also in ORG_AXIS_POLICY_EXCLUDED_TABLES).
  // Policy: breeze_current_scope()='system' OR breeze_has_partner_access(partner_id).
  // Functional forge: customerEmailDomainsRls.integration.test.ts.
  ['customer_email_domains', 'partner_id'],
  // Stripe payments (2026-06-15): one connected Stripe account per partner
  // (RLS shape 3, flat breeze_has_partner_access(partner_id)). The sibling
  // invoice_stripe_payments table carries a direct org_id column and is
  // auto-discovered as an ordinary shape-1 org-tenant table — not listed here.
  // Functional cross-partner forge proof: stripe-payments-rls.integration.test.ts.
  ['stripe_connect_accounts', 'partner_id'],
  // authenticator_policies: per-MSP approval-security policy (Shape 3). One row
  // per partner; policy gates on breeze_has_partner_access(partner_id) with a
  // system-scope OR branch. Functional forge: authenticatorRls.integration.test.ts.
  ['authenticator_policies', 'partner_id'],
  // Update rings + patch approvals (2026-06-21): partner-axis (RLS shape 3).
  // patch_policies has no org_id column — auto-discovery doesn't reach it.
  // patch_approvals likewise carries only partner_id (no org_id).
  // Functional cross-partner forge proof: update-rings-partner-scope.integration.test.ts.
  ['patch_policies', 'partner_id'],
  ['patch_approvals', 'partner_id'],
  // SentinelOne (partner-wide re-key, #1735): credentials + site mappings are
  // partner-axis (Shape 3). org_id is denormalized/nullable metadata only.
  // Also listed in ORG_AXIS_POLICY_EXCLUDED_TABLES (dual-list trap).
  ['s1_integrations', 'partner_id'],
  ['s1_org_mappings', 'partner_id'],
  // UniFi Network integration (Phase 1): one integration per partner (MSP
  // holds the UniFi API key); sync_runs are per-integration, keyed by
  // partner_id for fast filtering. unifi_site_mappings and unifi_devices
  // are direct org_id (Shape 1) and are auto-discovered — not listed here.
  ['unifi_integrations', 'partner_id'],
  ['unifi_sync_runs', 'partner_id'],
  // partner_login_branding (#2183): login-page branding for the MSP's own
  // technician login. Deliberately partner-ONLY (no org axis) — see
  // 2026-07-03-sso-partner-axis-login-branding.sql. partner_id is the PK.
  ['partner_login_branding', 'partner_id'],
  // Partner service principals and independently rotatable keys are both
  // partner-axis (Shape 3). The key table denormalizes partner_id and also
  // enforces composite ownership against its principal and rotation lineage.
  // Functional forge proof: partnerServicePrincipalRls.integration.test.ts.
  ['partner_service_principals', 'partner_id'],
  ['partner_service_principal_keys', 'partner_id'],
]);

// Tables whose policies reference both helpers (org OR partner). `users`
// is the canonical case: a user row is visible if the caller has access
// to the user's partner OR the user's org OR is the user themselves.
const DUAL_AXIS_TENANT_TABLES: ReadonlySet<string> = new Set<string>([
  'users',
  'deployment_invites',
  'access_reviews',
  // custom_field_definitions: a field is org-scoped (org_id set) OR
  // partner-wide (partner_id set, org_id NULL). Shipped org-only in the
  // baseline; converted to dual-axis in 2026-06-11-i-custom-fields-dual-axis-rls.
  'custom_field_definitions',
  // client_ai_prompt_templates: a template is org-scoped (org_id set) OR
  // partner-wide (partner_id set, org_id NULL). Created dual-axis from day one
  // in 2026-06-12-b-client-ai-foundation. The org_id column means the generic
  // org-tenant auto-discovery already picks it up (its policy string contains
  // breeze_has_org_access), so this entry is the only guard that asserts the
  // partner-axis (breeze_has_partner_access) branch — the dual-axis blindspot.
  // A functional breeze_app insert test lives in client-ai-templates-rls.integration.test.ts.
  'client_ai_prompt_templates',
  // configuration_policies (#1724): a policy is org-scoped (org_id set,
  // partner_id NULL — the original shape) OR partner-wide (partner_id set,
  // org_id NULL — "all orgs"). Converted from org-only to dual-axis in
  // 2026-06-27-config-policies-partner-ownership. Same blindspot as
  // client_ai_prompt_templates: the org_id column means org-tenant
  // auto-discovery already asserts the breeze_has_org_access branch, so this
  // entry is what asserts the breeze_has_partner_access (partner-wide) branch.
  // A CHECK constraint (configuration_policies_one_owner_chk) enforces exactly
  // one axis per row. Functional cross-partner forge proof:
  // configurationPoliciesPartnerRls.integration.test.ts.
  'configuration_policies',
  // software_catalog: a package is org-scoped (org_id set, partner_id NULL — the
  // baseline shape for custom packages) OR partner-wide (partner_id set, org_id
  // NULL — built-in EDR integration packages). Converted from org-only to
  // dual-axis in 2026-06-26-a-software-catalog-partner-axis. The org_id column
  // means org-tenant auto-discovery already asserts the breeze_has_org_access
  // branch; this entry asserts the breeze_has_partner_access (built-in) branch.
  // A CHECK constraint (software_catalog_one_owner_chk) enforces exactly one axis.
  'software_catalog',
  // software_policies (#2126, epic #2135): a policy is org-scoped (org_id set,
  // partner_id NULL) OR a partner-wide template (partner_id set, org_id NULL —
  // "all orgs"). Converted from org-only to dual-axis in
  // 2026-07-01-software-policies-partner-ownership. Same auto-discovery
  // blindspot as configuration_policies: this entry asserts the
  // breeze_has_partner_access branch. CHECK software_policies_one_owner_chk
  // enforces exactly one axis. Functional cross-partner forge proof:
  // softwarePoliciesPartnerRls.integration.test.ts.
  'software_policies',
  // software_policy_audit (#2126): dual-owned but NOT XOR — a device-level
  // event under a partner-wide policy carries BOTH the device's org_id and the
  // policy's partner_id so both admins can see it; CHECK
  // software_policy_audit_owner_chk requires at least one axis.
  'software_policy_audit',
  // security_policies (#2127, epic #2135): org-scoped OR partner-wide AV/EDR
  // baseline template. Converted from org-only to dual-axis in
  // 2026-07-01-security-policies-partner-ownership. CHECK
  // security_policies_one_owner_chk enforces exactly one axis. Functional
  // cross-partner forge proof: securityPoliciesPartnerRls.integration.test.ts.
  'security_policies',
  // alert_rules (#2128, epic #2135): org-scoped OR partner-wide standalone
  // alert rule (fired alerts always carry the DEVICE's org — alerts stays
  // org-only). Converted in 2026-07-01-alert-rules-partner-ownership. CHECK
  // alert_rules_one_owner_chk enforces exactly one axis. Functional
  // cross-partner forge proof: alertRulesPartnerRls.integration.test.ts.
  'alert_rules',
  // automation_policies (#2129, epic #2135): org-scoped OR partner-wide
  // compliance rule set (the config-policy "compliance" feature). Per-device
  // results (automation_policy_compliance) stay device-join — each result row
  // belongs to the device's own org. Converted in
  // 2026-07-01-automation-policies-partner-ownership. CHECK
  // automation_policies_one_owner_chk enforces exactly one axis. Functional
  // cross-partner forge + evaluation fan-out proof:
  // automationPoliciesPartnerRls.integration.test.ts.
  'automation_policies',
  // automations (#2133, epic #2135): org-scoped OR partner-wide standalone
  // automation ("on device.offline run diagnostic script" across all orgs).
  // automation_runs stays parent-join (its EXISTS policies gained the partner
  // branch on the automations parent in the same migration); worker-created
  // child rows (alerts, deployments) always take the DEVICE's org. Converted
  // in 2026-07-02-automations-partner-ownership. CHECK
  // automations_one_owner_chk enforces exactly one axis. Functional
  // cross-partner forge + event-trigger fan-out proof:
  // automationsPartnerRls.integration.test.ts.
  'automations',
  // sensitive_data_policies (#2131, epic #2135): org-scoped OR partner-wide
  // data-discovery policy. Scans/findings stay org-owned by the scanned
  // DEVICE's org (the scheduler sources scan org_id from the device).
  // Converted in 2026-07-01-sensitive-data-policies-partner-ownership. CHECK
  // sensitive_data_policies_one_owner_chk enforces exactly one axis.
  // Functional cross-partner forge + scheduler fan-out proof:
  // sensitiveDataPoliciesPartnerRls.integration.test.ts.
  'sensitive_data_policies',
  // peripheral_policies (#2131, epic #2135): org-scoped OR partner-wide
  // USB/peripheral policy. peripheral_events stay org-owned by the reporting
  // DEVICE's org. Converted in 2026-07-01-peripheral-policies-partner-
  // ownership. CHECK peripheral_policies_one_owner_chk enforces exactly one
  // axis. Functional cross-partner forge + distribution fan-out proof:
  // peripheralPoliciesPartnerRls.integration.test.ts.
  'peripheral_policies',
  // maintenance_windows (#2131, epic #2135): org-scoped OR partner-wide
  // maintenance window. maintenance_occurrences stay window-join (their
  // EXISTS policies gained the partner branch in the same migration).
  // Converted in 2026-07-01-maintenance-windows-partner-ownership. CHECK
  // maintenance_windows_one_owner_chk enforces exactly one axis. Functional
  // cross-partner forge + enforcement fan-out proof:
  // maintenanceWindowsPartnerRls.integration.test.ts.
  'maintenance_windows',
  // Alert delivery rails (#2130, epic #2135): org-scoped OR partner-wide
  // notification channel / routing rule / escalation policy.
  // alert_notifications stay alert-join (the firing device's org).
  // Converted in 2026-07-01-notification-rails-partner-ownership. CHECK
  // *_one_owner_chk enforces exactly one axis per table. Functional
  // cross-partner forge + dispatcher fan-out proof:
  // notificationRailsPartnerRls.integration.test.ts.
  'notification_channels',
  'notification_routing_rules',
  'escalation_policies',
  // sso_providers (#2183): org-axis (org_id set — customer-org SSO, the
  // original shape) OR partner-axis (partner_id set, org_id NULL — MSP
  // technician login). Converted in 2026-07-03-sso-partner-axis-login-branding.
  // Org auto-discovery asserts the org branch; this entry asserts the
  // breeze_has_partner_access branch. CHECK sso_providers_one_owner_chk
  // enforces exactly one axis. Functional forge proof:
  // ssoProvidersPartnerRls.integration.test.ts.
  'sso_providers',
  // ticket_forms (spec 2026-07-10): an intake form is org-owned (org_id set,
  // partner_id NULL) OR a partner-wide form (partner_id set, org_id NULL) —
  // XOR-enforced by ticket_forms_one_owner_chk. First dual-axis table in the
  // ticketing domain (ticket_categories / ticket_response_templates are
  // partner-axis-only).
  'ticket_forms',
  // backup_profiles (spec 2026-07-13): a backup selection profile ("what to
  // protect" for a device class) is org-scoped (org_id set, partner_id NULL)
  // OR partner-wide (partner_id set, org_id NULL — define "Server" once for
  // all orgs). Created dual-axis from day one in 2026-07-13-backup-profiles.
  // Org auto-discovery asserts the org branch; this entry asserts the
  // breeze_has_partner_access branch. CHECK backup_profiles_one_owner_chk
  // enforces exactly one axis. Destinations (backup_configs) stay org-owned —
  // credentials. Functional cross-partner forge proof:
  // backupProfilesPartnerRls.integration.test.ts.
  'backup_profiles',
  // config_policy_backup_settings (spec 2026-07-13): mirrors its parent
  // policy's ownership axis (org XOR partner, denormalized — no EXISTS join
  // to the parent in RLS). Was org-only NOT NULL until backup became
  // partner-linkable; converted in 2026-07-13-backup-profiles. CHECK
  // config_policy_backup_settings_one_owner_chk enforces exactly one axis.
  'config_policy_backup_settings',
  // contract_templates (spec 2026-07-16, epic #2135): a contract template is
  // org-scoped (org_id set, partner_id NULL) OR partner-wide (partner_id set,
  // org_id NULL — "all orgs"). Created dual-axis from day one in
  // 2026-07-16-contract-documents.sql, mirroring software_policies. The org_id
  // column means org-tenant auto-discovery already asserts the
  // breeze_has_org_access branch; this entry asserts the
  // breeze_has_partner_access (partner-wide) branch. CHECK
  // contract_templates_one_owner_chk enforces exactly one axis. Functional
  // cross-partner forge proof: contractTemplatesPartnerRls.integration.test.ts.
  'contract_templates',
  // contract_template_versions (spec 2026-07-16): same dual-axis shape as its
  // parent contract_templates, but the owner axes are DENORMALIZED onto the
  // version row rather than reached via an EXISTS join to the template (FK
  // children get NO RLS coverage for free) — the app layer disallows changing
  // a template's owner once versions exist, so the denorm cannot drift. CHECK
  // contract_template_versions_one_owner_chk enforces exactly one axis.
  // Functional cross-partner forge proof:
  // contractTemplatesPartnerRls.integration.test.ts.
  'contract_template_versions',
]);

// Tables that carry a `device_id` FK but no denormalized `org_id`. Their
// RLS policies join through `devices` to reach the org boundary.
// Policies must contain both `FROM devices` and `breeze_has_org_access`
// in the qual or with_check predicate (Phase 5 migration).
const DEVICE_ID_JOIN_POLICY_TABLES: ReadonlySet<string> = new Set<string>([
  'automation_policy_compliance',
  'deployment_devices',
  'deployment_results',
  'patch_job_results',
  'patch_rollbacks',
]);

// Tables that reach their tenant through a PARENT FK (no device_id, no
// denormalized org_id). Their RLS policies join through the named parent
// table(s) to the org boundary. Each entry maps the child table to the
// parent table name(s) its policy predicate must reference; the policy must
// contain both `FROM <parent>` and `breeze_has_org_access` in the qual or
// with_check (migration 2026-05-30-fk-child-tables-rls.sql).
//
// This is the generalization of the Phase 5 device-join shape: same EXISTS
// structure, but the join target is the row's actual parent rather than
// `devices`. A child table keyed by a parent FK is the single most common way
// a tenant table escapes the org_id-column auto-discovery above and ships with
// NO rls — keep this list authoritative so the contract test catches the next
// one. automation_runs lists BOTH parents because config-policy-driven runs
// leave automation_id NULL and reach their org via config_policy_id instead.
const PARENT_FK_JOIN_POLICY_TABLES: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['automation_runs', ['automations', 'configuration_policies']],
  ['ai_messages', ['ai_sessions']],
  ['ai_tool_executions', ['ai_sessions']],
  // NOTE: script_execution_batches is NOT here — it carries a denormalized
  // org_id column (2026-05-31 migration) and is auto-discovered as an ordinary
  // org-tenant table, because a nested-RLS join through its nullable-org parent
  // `scripts` could not satisfy the system-script INSERT under bound parameters.
  ['software_versions', ['software_catalog']],
  ['alert_correlations', ['alerts']],
  ['alert_notifications', ['alerts']],
  // 2026-06-13-b backstop: seven more child tables that shipped with NO rls and
  // reach their tenant only through a parent FK. role_permissions' parent
  // `roles` is dual-axis (org_id/partner_id) — its policy ORs in
  // breeze_has_partner_access + a system-role carve-out, but still references
  // breeze_has_org_access and joins through `roles`, so this assertion holds.
  ['webhook_deliveries', ['webhooks']],
  ['network_monitor_alert_rules', ['network_monitors']],
  ['network_monitor_results', ['network_monitors']],
  ['role_permissions', ['roles']],
  ['plugin_logs', ['plugin_installations']],
  ['report_runs', ['reports']],
  ['maintenance_occurrences', ['maintenance_windows']],
  // 2026-06-23 security-review #1 backstop: five tenant child tables that
  // shipped with NO rls and reach their org only through a parent FK. The three
  // config_policy_* children reach the org via a 2–3 hop chain expressed as
  // scalar subqueries, so the org-bearing parent in their EXISTS `FROM` is
  // configuration_policies. See 2026-06-23-sec-review-1-fk-child-rls-backstop.sql.
  ['config_policy_sensitive_data_settings', ['configuration_policies']],
  ['config_policy_monitoring_settings', ['configuration_policies']],
  ['config_policy_monitoring_watches', ['configuration_policies']],
  ['config_policy_remote_access_settings', ['configuration_policies']],
  ['config_policy_feature_links', ['configuration_policies']],
  ['config_policy_assignments', ['configuration_policies']],
  ['config_policy_alert_rules', ['configuration_policies']],
  ['config_policy_automations', ['configuration_policies']],
  ['config_policy_compliance_rules', ['configuration_policies']],
  ['config_policy_patch_settings', ['configuration_policies']],
  ['config_policy_maintenance_settings', ['configuration_policies']],
  ['config_policy_event_log_settings', ['configuration_policies']],
  ['dashboard_widgets', ['analytics_dashboards']],
  ['backup_snapshot_files', ['backup_snapshots']],
  // psa_ticket_mappings already shipped a correct single-table-join policy
  // (2026-04-11-bucket-c-dead-cleanup-rls.sql) but had no org_id column and was
  // never allowlisted, so the contract test couldn't see it. Register it so a
  // future regression that drops/weakens the policy is caught.
  ['psa_ticket_mappings', ['psa_connections']],
  // ticket_form_org_links (2026-07-11): org allowlist for partner-wide
  // ticket_forms. Its policy joins through ticket_forms and OR's in the
  // parent's dual-axis predicate (org OR partner OR system) — a plain
  // breeze_has_org_access(parent.org_id) join would be WRONG because the
  // parent's org_id is NULL for the partner-wide forms this table scopes.
  ['ticket_form_org_links', ['ticket_forms']],
]);

// Tables scoped to the calling user via breeze_current_user_id().
// Policies must reference `breeze_current_user_id` in the predicate
// (Phase 6 migration).
const USER_ID_SCOPED_TABLES: ReadonlySet<string> = new Set<string>([
  'user_sso_identities',
  'push_notifications',
  'mobile_devices',
  // ticket_comments: Shape 6 on the author axis, PLUS an extra permissive
  // SELECT policy (breeze_ticket_parent_select, 2026-06-10-a migration)
  // that ORs in visibility when the parent ticket is org-accessible —
  // portal-authored rows (portal_user_id set, user_id NULL) would
  // otherwise be invisible to org/partner technicians. The EXISTS join
  // through tickets is #1016-safe: tickets.org_id is NOT NULL and the
  // tickets policy has no OR branches.
  'ticket_comments',
  'access_review_items',
  'oauth_authorization_codes',
  'oauth_grants',
  'oauth_refresh_tokens',
  // oauth_sessions: account_id (= users.id) is nullable for anonymous
  // pre-login Sessions. Policy matches the user-scope-OR-system-scope
  // pattern of oauth_authorization_codes; the coverage test only checks
  // that breeze_current_user_id is referenced.
  'oauth_sessions',
  // oauth_interactions: short-lived OAuth interaction records. Pre-login
  // interactions have no accountId; once login happens the policy gates
  // access by (payload->session->accountId)::uuid = breeze_current_user_id().
  // System-scope bypass covers the adapter writes (runOutsideDbContext).
  'oauth_interactions',
  // approval_requests: MCP step-up approval records, scoped to the requesting
  // user via breeze_current_user_id(). Shape 6 policy, plus an
  // `OR breeze_current_scope() = 'system'` branch (migration
  // 2026-05-16-approval-shape6-system-bypass.sql) so the BullMQ expiry
  // reaper can transition rows under system scope.
  'approval_requests',
  // account_deletion_requests: user-initiated deletion queue records, scoped
  // to the requesting user via breeze_current_user_id(). Shape 6 policy with
  // the same system-scope OR branch so the account-deletion admin queue
  // (runWithSystemDbAccess) can read/process the queue.
  'account_deletion_requests',
  // refresh_token_families: OAuth 2.1 refresh-token chain records, scoped to
  // the token owner via breeze_current_user_id(). System-initiated revocation
  // (reuse detection in /auth/refresh) uses withSystemDbAccessContext.
  'refresh_token_families',
  // user_passkeys: WebAuthn passkey credentials, scoped to the owning user
  // via breeze_current_user_id(), with an OR breeze_current_scope() = 'system'
  // branch for system-scope access (Shape 6).
  'user_passkeys',
  // authenticator_devices: Breeze Authenticator approver device keys, scoped to
  // the owning user via breeze_current_user_id(), with an
  // OR breeze_current_scope() = 'system' branch (Shape 6). Mirrors user_passkeys.
  'authenticator_devices',
]);

const REQUIRED_CMDS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

interface TableRow {
  table_name: string;
  rls_on: boolean;
  covered_cmds: string[] | null;
}

function offendersFrom(rows: TableRow[]): Array<{ table: string; rls_on: boolean; missing_cmds: string[] }> {
  return rows
    .filter((r) => !EXEMPT_TABLES.has(r.table_name))
    .map((r) => {
      const covered = new Set<string>(r.covered_cmds ?? []);
      const missing = REQUIRED_CMDS.filter((cmd) => !covered.has(cmd));
      return { table: r.table_name, rls_on: r.rls_on, missing_cmds: missing };
    })
    .filter((r) => !r.rls_on || r.missing_cmds.length > 0);
}

describe('RLS coverage contract', () => {
  it('oauth_clients shared rows are visible only to system scope or granted partners', async () => {
    const rows = (await db.execute(sql`
      SELECT
        policyname,
        cmd,
        COALESCE(qual, '') AS qual,
        COALESCE(with_check, '') AS with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'oauth_clients'
      ORDER BY policyname;
    `)) as unknown as Array<{
      policyname: string;
      cmd: string;
      qual: string;
      with_check: string;
    }>;

    const combined = rows.map((row) => `${row.qual}\n${row.with_check}`).join('\n');
    const selectPolicy = rows.find((row) => row.policyname === 'oauth_clients_select_access');
    const writePolicies = rows.filter((row) =>
      [
        'oauth_clients_insert_access',
        'oauth_clients_update_access',
        'oauth_clients_delete_access',
      ].includes(row.policyname)
    );

    expect(selectPolicy?.qual).toContain('breeze_current_scope() = \'system\'');
    expect(selectPolicy?.qual).toContain('oauth_client_partner_grants');
    expect(selectPolicy?.qual).toContain('breeze_has_partner_access(g.partner_id)');
    expect(combined).not.toContain('partner_id IS NULL');
    expect(writePolicies).toHaveLength(3);
    for (const policy of writePolicies) {
      expect(`${policy.qual}\n${policy.with_check}`).not.toContain('partner_id IS NULL');
    }
  });

  it('OAuth token-row policies do not grant generic org-axis access', async () => {
    const rows = (await db.execute(sql`
      SELECT
        tablename,
        policyname,
        COALESCE(qual, '') AS qual,
        COALESCE(with_check, '') AS with_check
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY(ARRAY[
          'oauth_authorization_codes',
          'oauth_grants',
          'oauth_refresh_tokens'
        ]::text[])
      ORDER BY tablename, policyname;
    `)) as unknown as Array<{
      tablename: string;
      policyname: string;
      qual: string;
      with_check: string;
    }>;

    expect(rows.map((row) => row.tablename).sort()).toEqual([
      'oauth_authorization_codes',
      'oauth_grants',
      'oauth_refresh_tokens',
    ]);

    for (const row of rows) {
      const predicate = `${row.qual}\n${row.with_check}`;
      expect(predicate).toContain('breeze_current_scope() = \'system\'');
      expect(predicate).not.toContain('breeze_has_org_access');
    }

    const authCodes = rows.find((row) => row.tablename === 'oauth_authorization_codes');
    const grants = rows.find((row) => row.tablename === 'oauth_grants');
    const refreshTokens = rows.find((row) => row.tablename === 'oauth_refresh_tokens');

    expect(`${authCodes?.qual}\n${authCodes?.with_check}`).toContain('user_id = breeze_current_user_id()');
    expect(`${grants?.qual}\n${grants?.with_check}`).toContain('account_id = breeze_current_user_id()');
    expect(`${refreshTokens?.qual}\n${refreshTokens?.with_check}`).toContain('user_id = breeze_current_user_id()');
  });

  it('sso_sessions is forced-RLS and reachable only from system scope', async () => {
    const [cls] = (await db.execute(sql`
      SELECT c.relrowsecurity AS rls_on, c.relforcerowsecurity AS force_on
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'sso_sessions';
    `)) as unknown as Array<{ rls_on: boolean; force_on: boolean }>;

    expect(cls?.rls_on).toBe(true);
    expect(cls?.force_on).toBe(true);

    const policies = (await db.execute(sql`
      SELECT policyname, cmd, COALESCE(qual, '') AS qual, COALESCE(with_check, '') AS with_check
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'sso_sessions'
      ORDER BY policyname;
    `)) as unknown as Array<{ policyname: string; cmd: string; qual: string; with_check: string }>;

    // Exactly one ALL-command system-only policy. sso_sessions is a pre-auth
    // CSRF/PKCE transaction store with no tenant column — no tenant axis may
    // read or write it, only withSystemDbAccessContext.
    expect(policies).toHaveLength(1);
    expect(policies[0]?.policyname).toBe('sso_sessions_system_only');
    expect(policies[0]?.cmd).toBe('ALL');
    const predicate = `${policies[0]?.qual}\n${policies[0]?.with_check}`;
    expect(predicate).toContain("current_setting('breeze.scope'");
    expect(predicate).not.toContain('breeze_has_org_access');
    expect(predicate).not.toContain('breeze_has_partner_access');
  });

  it('sso_sessions carries the provider-version and link-binding columns', async () => {
    const cols = (await db.execute(sql`
      SELECT column_name, is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sso_sessions'
        AND column_name IN ('provider_version', 'initiating_auth_epoch', 'initiating_mfa_epoch', 'initiating_session_id')
      ORDER BY column_name;
    `)) as unknown as Array<{ column_name: string; is_nullable: string; data_type: string }>;

    expect(cols.map((c) => c.column_name)).toEqual([
      'initiating_auth_epoch', 'initiating_mfa_epoch', 'initiating_session_id', 'provider_version',
    ]);
    // All nullable: login sessions have no initiating user; provider_version is
    // NULL only for pre-deploy in-flight rows (which the callback rejects).
    for (const c of cols) expect(c.is_nullable).toBe('YES');

    const [pv] = (await db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sso_providers' AND column_name = 'config_version';
    `)) as unknown as Array<{ is_nullable: string; column_default: string }>;
    expect(pv?.is_nullable).toBe('NO');
    expect(pv?.column_default).toContain('1');

    const [drcb] = (await db.execute(sql`
      SELECT is_nullable, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sso_providers' AND column_name = 'default_role_configured_by';
    `)) as unknown as Array<{ is_nullable: string; data_type: string }>;
    expect(drcb?.is_nullable).toBe('YES');
    expect(drcb?.data_type).toBe('uuid');
  });

  it('every tenant-scoped public table has FORCE ROW LEVEL SECURITY enabled', async () => {
    const explicitTables = Array.from(new Set([
      ...ORG_ID_KEYED_TENANT_TABLES,
      ...PARTNER_TENANT_TABLES.keys(),
      ...DUAL_AXIS_TENANT_TABLES,
      ...DEVICE_ID_JOIN_POLICY_TABLES,
      ...PARENT_FK_JOIN_POLICY_TABLES.keys(),
      ...USER_ID_SCOPED_TABLES,
    ]));

    const rows = (await db.execute(sql`
      WITH org_id_tables AS (
        SELECT DISTINCT c.relname, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_schema = n.nspname AND col.table_name = c.relname
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND col.column_name = 'org_id'
      ),
      explicit_tables AS (
        SELECT c.relname, c.relforcerowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${explicitTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      tenant_tables AS (
        SELECT * FROM org_id_tables
        UNION
        SELECT * FROM explicit_tables
      )
      SELECT relname AS table_name, relforcerowsecurity AS force_rls_on
      FROM tenant_tables
      ORDER BY relname;
    `)) as unknown as Array<{ table_name: string; force_rls_on: boolean }>;

    const offenders = rows
      .filter((row) => !EXEMPT_TABLES.has(row.table_name))
      .filter((row) => !row.force_rls_on)
      .map((row) => row.table_name);
    const returnedTables = new Set(rows.map((row) => row.table_name));
    const missingExplicitTables = explicitTables.filter(
      (table) => !EXEMPT_TABLES.has(table) && !returnedTables.has(table),
    );

    expect(
      [...offenders, ...missingExplicitTables],
      `Tenant-scoped tables missing from the database or missing FORCE ROW LEVEL SECURITY:\n${JSON.stringify([...offenders, ...missingExplicitTables], null, 2)}\n\n` +
        `Fix: add an idempotent migration that runs ALTER TABLE ... FORCE ROW LEVEL SECURITY for each offender.`
    ).toEqual([]);
  });

  it('deployment_invites has a database invariant tying org_id to partner_id', async () => {
    const rows = (await db.execute(sql`
      SELECT
        c.conname,
        c.contype,
        src.relname AS source_table,
        target.relname AS target_table,
        pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class src ON src.oid = c.conrelid
      JOIN pg_class target ON target.oid = c.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
      WHERE n.nspname = 'public'
        AND src.relname = 'deployment_invites'
        AND c.conname = 'deployment_invites_org_partner_fk';
    `)) as unknown as Array<{
      conname: string;
      contype: string;
      source_table: string;
      target_table: string;
      definition: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.contype).toBe('f');
    expect(rows[0]?.target_table).toBe('organizations');
    expect(rows[0]?.definition).toContain('FOREIGN KEY (org_id, partner_id)');
    expect(rows[0]?.definition).toContain('REFERENCES organizations(id, partner_id)');
  });

  // Issue #750: device-child tables denormalize devices.org_id for the
  // RLS hot path. If that copy is not kept in sync on an org move, the
  // stale child row fails the UPDATE policy's USING expression on the
  // agent inventory upserts. The 2026-05-18 migration installs a
  // SECURITY DEFINER cascade trigger on devices + a backfill. Guard both
  // the structural invariant (trigger present, definer-rights, covers
  // every device-child table) and the data invariant (zero drift).
  it('device.org_id changes cascade to every device-child table (no stale org_id drift) [#750]', async () => {
    const trigger = (await db.execute(sql`
      SELECT
        t.tgname,
        t.tgenabled,
        p.prosecdef,
        pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE n.nspname = 'public'
        AND c.relname = 'devices'
        AND t.tgname = 'breeze_cascade_device_org_id'
        AND NOT t.tgisinternal;
    `)) as unknown as Array<{
      tgname: string;
      tgenabled: string;
      prosecdef: boolean;
      def: string;
    }>;

    expect(
      trigger,
      'Missing breeze_cascade_device_org_id trigger on devices — org moves will leave stale org_id on device-child tables and break agent inventory upserts (#750). Re-apply migration 2026-05-18-device-child-orgid-cascade.sql.'
    ).toHaveLength(1);
    // SECURITY DEFINER: the cascade must run RLS-exempt or it cannot
    // rewrite the stale child rows it exists to fix.
    expect(trigger[0]?.prosecdef).toBe(true);
    // Enabled in "origin/local" mode (fires on normal writes), not disabled.
    expect(trigger[0]?.tgenabled).toBe('O');
    expect(trigger[0]?.def).toContain('UPDATE OF org_id');
    expect(trigger[0]?.def).toContain('FOR EACH ROW');

    // The discovery helper must resolve every table that denormalizes a
    // uuid org_id alongside a uuid device_id — that is exactly the set
    // the cascade and backfill iterate. A new such table is auto-covered.
    const discovered = (await db.execute(sql`
      SELECT count(*)::int AS n FROM public.breeze_device_child_orgid_tables();
    `)) as unknown as Array<{ n: number }>;
    expect(discovered[0]?.n ?? 0).toBeGreaterThan(0);

    // Data invariant: no device-child row may carry an org_id that
    // disagrees with its device. Read under system scope so RLS doesn't
    // hide cross-org rows from the audit.
    const drift = await withSystemDbAccessContext(async () => {
      const tables = (await db.execute(sql`
        SELECT public.breeze_device_child_orgid_tables() AS t;
      `)) as unknown as Array<{ t: string }>;

      const offenders: Array<{ table_name: string; n: number }> = [];
      for (const { t } of tables) {
        const [row] = (await db.execute(sql`
          SELECT count(*)::int AS n
          FROM ${sql.identifier(t)} c
          JOIN public.devices d ON d.id = c.device_id
          WHERE c.org_id IS DISTINCT FROM d.org_id;
        `)) as unknown as Array<{ n: number }>;
        const n = row?.n ?? 0;
        if (n > 0) offenders.push({ table_name: t, n });
      }
      return offenders;
    });

    expect(
      drift,
      `device-child tables with org_id drift vs devices.org_id (#750 regression — cascade trigger not keeping these in sync):\n${JSON.stringify(drift, null, 2)}`
    ).toEqual([]);
  });

  it('every org-tenant public table has RLS on and all four DML commands covered by breeze_has_org_access', async () => {
    const idKeyedList = Array.from(ORG_ID_KEYED_TENANT_TABLES);

    const rows = (await db.execute(sql`
      WITH org_id_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN information_schema.columns col
          ON col.table_schema = n.nspname AND col.table_name = c.relname
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND col.column_name = 'org_id'
          AND c.relname <> ALL(${sql.raw(
            `ARRAY[${Array.from(ORG_AXIS_POLICY_EXCLUDED_TABLES).map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      id_keyed_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${idKeyedList.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      tenant_tables AS (
        SELECT * FROM org_id_tables
        UNION
        SELECT * FROM id_keyed_tables
      ),
      covering_policies AS (
        SELECT
          p.tablename,
          CASE WHEN p.cmd = 'ALL' THEN cmd_name ELSE p.cmd END AS cmd
        FROM pg_policies p
        CROSS JOIN UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd_name
        WHERE p.schemaname = 'public'
          AND p.permissive = 'PERMISSIVE'
          AND (
            COALESCE(p.qual, '') LIKE '%breeze_has_org_access%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_has_org_access%'
          )
          AND (p.cmd = 'ALL' OR p.cmd = cmd_name)
      )
      SELECT
        t.relname AS table_name,
        t.relrowsecurity AS rls_on,
        ARRAY(
          SELECT DISTINCT cp.cmd
          FROM covering_policies cp
          WHERE cp.tablename = t.relname
          ORDER BY cp.cmd
        ) AS covered_cmds
      FROM tenant_tables t
      ORDER BY t.relname;
    `)) as unknown as TableRow[];

    const offenders = offendersFrom(rows);

    expect(
      offenders,
      `Org-tenant tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add a migration that enables RLS and installs policies covering SELECT, INSERT, UPDATE, and DELETE. ` +
        `Use breeze_has_org_access(org_id) — or breeze_has_org_access(id) for id-keyed tenant tables — in the policy ` +
        `predicate. See 2026-04-11-rewrite-backup-rls-policies.sql for the per-command shape and ` +
        `2026-04-11-organizations-rls.sql for the id-keyed shape.`
    ).toEqual([]);
  });

  it('every partner-tenant public table has RLS on and all four DML commands covered by breeze_has_partner_access', async () => {
    const partnerTables = Array.from(PARTNER_TENANT_TABLES.keys());

    const rows = (await db.execute(sql`
      WITH tenant_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${partnerTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      covering_policies AS (
        SELECT
          p.tablename,
          CASE WHEN p.cmd = 'ALL' THEN cmd_name ELSE p.cmd END AS cmd
        FROM pg_policies p
        CROSS JOIN UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd_name
        WHERE p.schemaname = 'public'
          AND p.permissive = 'PERMISSIVE'
          AND (
            COALESCE(p.qual, '') LIKE '%breeze_has_partner_access%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_has_partner_access%'
          )
          AND (p.cmd = 'ALL' OR p.cmd = cmd_name)
      )
      SELECT
        t.relname AS table_name,
        t.relrowsecurity AS rls_on,
        ARRAY(
          SELECT DISTINCT cp.cmd
          FROM covering_policies cp
          WHERE cp.tablename = t.relname
          ORDER BY cp.cmd
        ) AS covered_cmds
      FROM tenant_tables t
      ORDER BY t.relname;
    `)) as unknown as TableRow[];

    const returnedTables = new Set(rows.map((row) => row.table_name));
    const missingTables = partnerTables
      .filter((table) => !returnedTables.has(table))
      .map((table) => ({ table, rls_on: false, missing_cmds: [...REQUIRED_CMDS] }));
    const offenders = [...offendersFrom(rows), ...missingTables];

    expect(
      offenders,
      `Partner-tenant tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add a migration that enables RLS and installs policies covering SELECT, INSERT, UPDATE, and DELETE. ` +
        `Use breeze_has_partner_access(id) or breeze_has_partner_access(partner_id) in the policy predicate. ` +
        `See 2026-04-11-partners-rls.sql for the template.`
    ).toEqual([]);
  });

  it('every dual-axis tenant table has RLS on and all four DML commands covered by breeze_has_org_access or breeze_has_partner_access', async () => {
    const dualTables = Array.from(DUAL_AXIS_TENANT_TABLES);

    const rows = (await db.execute(sql`
      WITH tenant_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${dualTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      covering_policies AS (
        SELECT
          p.tablename,
          CASE WHEN p.cmd = 'ALL' THEN cmd_name ELSE p.cmd END AS cmd
        FROM pg_policies p
        CROSS JOIN UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd_name
        WHERE p.schemaname = 'public'
          AND p.permissive = 'PERMISSIVE'
          AND (
            COALESCE(p.qual, '') LIKE '%breeze_has_org_access%'
            OR COALESCE(p.qual, '') LIKE '%breeze_has_partner_access%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_has_org_access%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_has_partner_access%'
          )
          AND (p.cmd = 'ALL' OR p.cmd = cmd_name)
      )
      SELECT
        t.relname AS table_name,
        t.relrowsecurity AS rls_on,
        ARRAY(
          SELECT DISTINCT cp.cmd
          FROM covering_policies cp
          WHERE cp.tablename = t.relname
          ORDER BY cp.cmd
        ) AS covered_cmds
      FROM tenant_tables t
      ORDER BY t.relname;
    `)) as unknown as TableRow[];

    const offenders = offendersFrom(rows);

    expect(
      offenders,
      `Dual-axis tenant tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: each DML command must be covered by a policy referencing at least one of ` +
        `breeze_has_org_access or breeze_has_partner_access. See 2026-04-11-users-rls.sql ` +
        `for the users table template (the canonical dual-axis case with a self-read branch).`
    ).toEqual([]);
  });

  it('every Phase 5 join-policy table has RLS on and all four DML commands covered by a device-join policy', async () => {
    const joinTables = Array.from(DEVICE_ID_JOIN_POLICY_TABLES);

    const rows = (await db.execute(sql`
      WITH tenant_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${joinTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      covering_policies AS (
        SELECT
          p.tablename,
          CASE WHEN p.cmd = 'ALL' THEN cmd_name ELSE p.cmd END AS cmd
        FROM pg_policies p
        CROSS JOIN UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd_name
        WHERE p.schemaname = 'public'
          AND p.permissive = 'PERMISSIVE'
          AND (
            COALESCE(p.qual, '') LIKE '%FROM devices%'
            OR COALESCE(p.with_check, '') LIKE '%FROM devices%'
          )
          AND (
            COALESCE(p.qual, '') LIKE '%breeze_has_org_access%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_has_org_access%'
          )
          AND (p.cmd = 'ALL' OR p.cmd = cmd_name)
      )
      SELECT
        t.relname AS table_name,
        t.relrowsecurity AS rls_on,
        ARRAY(
          SELECT DISTINCT cp.cmd
          FROM covering_policies cp
          WHERE cp.tablename = t.relname
          ORDER BY cp.cmd
        ) AS covered_cmds
      FROM tenant_tables t
      ORDER BY t.relname;
    `)) as unknown as TableRow[];

    const offenders = offendersFrom(rows);

    expect(
      offenders,
      `Phase 5 join-policy tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add a migration that enables RLS and installs policies covering SELECT, INSERT, UPDATE, and DELETE. ` +
        `Each policy predicate must join through devices and call breeze_has_org_access, e.g.: ` +
        `EXISTS (SELECT 1 FROM devices d WHERE d.id = device_id AND breeze_has_org_access(d.org_id)). ` +
        `See the Phase 5 migration for the canonical shape.`
    ).toEqual([]);
  });

  it('every parent-FK join-policy table has RLS on and all four DML commands covered by a parent-join org-access policy', async () => {
    const offenders: Array<{ table: string; rls_on: boolean; missing_cmds: string[] }> = [];

    for (const [table, parents] of PARENT_FK_JOIN_POLICY_TABLES) {
      // A covering policy must (a) reach the org via breeze_has_org_access and
      // (b) actually join through one of the declared parent tables — so a
      // policy that referenced breeze_has_org_access without the correct join
      // (or vice versa) does NOT count. parents is a small fixed allowlist, so
      // sql.raw interpolation here is safe (no user input).
      const parentRef = parents
        .map(
          (p) =>
            `(COALESCE(pp.qual, '') LIKE '%FROM ${p}%' OR COALESCE(pp.with_check, '') LIKE '%FROM ${p}%')`,
        )
        .join(' OR ');

      const rows = (await db.execute(sql`
        WITH t AS (
          SELECT c.relname, c.relrowsecurity
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ${table}
        ),
        covering_policies AS (
          SELECT DISTINCT
            CASE WHEN pp.cmd = 'ALL' THEN cmd_name ELSE pp.cmd END AS cmd
          FROM pg_policies pp
          CROSS JOIN UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd_name
          WHERE pp.schemaname = 'public'
            AND pp.tablename = ${table}
            AND pp.permissive = 'PERMISSIVE'
            AND (
              COALESCE(pp.qual, '') LIKE '%breeze_has_org_access%'
              OR COALESCE(pp.with_check, '') LIKE '%breeze_has_org_access%'
            )
            AND (${sql.raw(parentRef)})
            AND (pp.cmd = 'ALL' OR pp.cmd = cmd_name)
        )
        SELECT
          t.relname AS table_name,
          t.relrowsecurity AS rls_on,
          ARRAY(SELECT cmd FROM covering_policies ORDER BY cmd) AS covered_cmds
        FROM t;
      `)) as unknown as TableRow[];

      const row = rows[0];
      const covered = new Set<string>(row?.covered_cmds ?? []);
      const missing = REQUIRED_CMDS.filter((cmd) => !covered.has(cmd));
      if (!row || !row.rls_on || missing.length > 0) {
        offenders.push({ table, rls_on: Boolean(row?.rls_on), missing_cmds: missing });
      }
    }

    expect(
      offenders,
      `Parent-FK join-policy tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add an idempotent migration that runs ENABLE + FORCE ROW LEVEL SECURITY and installs ` +
        `SELECT/INSERT/UPDATE/DELETE policies whose predicate joins through the table's parent and calls ` +
        `breeze_has_org_access(parent.org_id), e.g.: ` +
        `EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_runs.automation_id AND breeze_has_org_access(a.org_id)). ` +
        `See 2026-05-30-fk-child-tables-rls.sql for the canonical shape and the PARENT_FK_JOIN_POLICY_TABLES allowlist.`
    ).toEqual([]);
  });

  it('every Phase 6 user-id-scoped table has RLS on and all four DML commands covered by a breeze_current_user_id policy', async () => {
    const userTables = Array.from(USER_ID_SCOPED_TABLES);

    const rows = (await db.execute(sql`
      WITH tenant_tables AS (
        SELECT c.oid, c.relname, c.relrowsecurity
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY(${sql.raw(
            `ARRAY[${userTables.map((t) => `'${t}'`).join(',')}]::text[]`,
          )})
      ),
      covering_policies AS (
        SELECT
          p.tablename,
          CASE WHEN p.cmd = 'ALL' THEN cmd_name ELSE p.cmd END AS cmd
        FROM pg_policies p
        CROSS JOIN UNNEST(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS cmd_name
        WHERE p.schemaname = 'public'
          AND p.permissive = 'PERMISSIVE'
          AND (
            COALESCE(p.qual, '') LIKE '%breeze_current_user_id%'
            OR COALESCE(p.with_check, '') LIKE '%breeze_current_user_id%'
          )
          AND (p.cmd = 'ALL' OR p.cmd = cmd_name)
      )
      SELECT
        t.relname AS table_name,
        t.relrowsecurity AS rls_on,
        ARRAY(
          SELECT DISTINCT cp.cmd
          FROM covering_policies cp
          WHERE cp.tablename = t.relname
          ORDER BY cp.cmd
        ) AS covered_cmds
      FROM tenant_tables t
      ORDER BY t.relname;
    `)) as unknown as TableRow[];

    const offenders = offendersFrom(rows);

    expect(
      offenders,
      `Phase 6 user-id-scoped tables missing RLS coverage:\n${JSON.stringify(offenders, null, 2)}\n\n` +
        `Fix: add a migration that enables RLS and installs policies covering SELECT, INSERT, UPDATE, and DELETE. ` +
        `Each policy predicate must reference breeze_current_user_id(), e.g.: ` +
        `user_id = breeze_current_user_id(). ` +
        `See the Phase 6 migration for the canonical shape.`
    ).toEqual([]);
  });
});

// ===========================================================================
// approval_requests — Shape 6 forge test
//
// The pg_catalog inspection above only checks that a policy referencing
// breeze_current_user_id() exists for each DML command. It does NOT prove
// Postgres actually rejects a cross-user write — a refactor that replaces
// the canonical user_id = breeze_current_user_id() predicate with a
// permissive `true` would still pass the catalog check but silently let
// any user act on any approval row.
//
// This block forges cross-user reads/writes against a real DB connection
// (as `breeze_app`, the unprivileged role) and asserts Postgres enforces
// the Shape 6 policy in practice. It is purposefully self-contained so it
// can run under vitest.config.rls-coverage.ts (which deliberately does NOT
// load setup.ts and thus has no per-test TRUNCATE) — fixtures are seeded
// via withSystemDbAccessContext and torn down by id in an afterAll.
// ===========================================================================
describe('approval_requests RLS — cross-user forge enforcement (Shape 6)', () => {
  // Stable suffix so re-runs against a long-lived DB don't collide on
  // users.email (UNIQUE) but tests within a single run share the fixture.
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partnerSlug = `rls-approvals-partner-${runSuffix}`;
  const userAEmail = `rls-approvals-a-${runSuffix}@example.test`;
  const userBEmail = `rls-approvals-b-${runSuffix}@example.test`;

  let partnerId: string;
  let userAId: string;
  let userBId: string;
  let approvalAId: string | null = null;

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `RLS Approvals Partner ${runSuffix}`,
          slug: partnerSlug,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for approvals RLS forge test');
      partnerId = partner.id;

      const [a, b] = await db
        .insert(users)
        .values([
          {
            partnerId: partner.id,
            email: userAEmail,
            name: 'RLS Approvals User A',
            status: 'active',
          },
          {
            partnerId: partner.id,
            email: userBEmail,
            name: 'RLS Approvals User B',
            status: 'active',
          },
        ])
        .returning({ id: users.id });
      if (!a || !b) throw new Error('failed to seed users for approvals RLS forge test');
      userAId = a.id;
      userBId = b.id;
    });
  }

  afterAll(async () => {
    // approval_requests now has a system-scope OR branch (migration
    // 2026-05-16-approval-shape6-system-bypass.sql), so system context can
    // tear the row down directly alongside the users/partners fixtures.
    await withSystemDbAccessContext(async () => {
      if (approvalAId) {
        await db.delete(approvalRequests).where(eq(approvalRequests.id, approvalAId!));
      }
      if (userAId) await db.delete(users).where(eq(users.id, userAId));
      if (userBId) await db.delete(users).where(eq(users.id, userBId));
      if (partnerId) await db.delete(partners).where(eq(partners.id, partnerId));
    });
  });

  // Build a per-user DbAccessContext. Shape 6 only needs `userId`;
  // scope='organization' with empty accessibleOrgIds keeps the caller's
  // org/partner reach to none so no other policy accidentally green-lights
  // the row.
  function userContext(userId: string) {
    return {
      scope: 'organization' as const,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [],
      userId,
    };
  }

  it('user A can INSERT and SELECT their own approval_request row', async () => {
    await ensureFixtures();

    const inserted = await withDbAccessContext(userContext(userAId), async () =>
      db
        .insert(approvalRequests)
        .values({
          userId: userAId,
          requestingClientLabel: 'rls-forge-client',
          actionLabel: 'forge.test',
          actionToolName: 'forge.test',
          riskTier: 'low',
          riskSummary: 'rls forge test seed',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        })
        .returning({ id: approvalRequests.id })
    );

    expect(inserted).toHaveLength(1);
    approvalAId = inserted[0]!.id;

    const visibleToA = await withDbAccessContext(userContext(userAId), async () =>
      db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalAId!))
    );
    expect(visibleToA.map((r) => r.id)).toEqual([approvalAId]);
  });

  it('user B SELECT cannot see user A\'s row (RLS hides it via USING)', async () => {
    await ensureFixtures();
    if (!approvalAId) throw new Error('seed test must run first');

    const visibleToB = await withDbAccessContext(userContext(userBId), async () =>
      db
        .select({ id: approvalRequests.id })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalAId!))
    );
    expect(visibleToB).toEqual([]);
  });

  it('user B UPDATE on user A\'s row affects 0 rows (USING filters the WHERE)', async () => {
    await ensureFixtures();
    if (!approvalAId) throw new Error('seed test must run first');

    // The policy USING clause filters the row out before WITH CHECK runs,
    // so this is a no-op rather than an RLS violation. The status remains
    // 'pending' regardless.
    const updated = await withDbAccessContext(userContext(userBId), async () =>
      db
        .update(approvalRequests)
        .set({ status: 'approved', decidedAt: new Date() })
        .where(eq(approvalRequests.id, approvalAId!))
        .returning({ id: approvalRequests.id })
    );
    expect(updated).toEqual([]);

    // Read back as user A (the row's owner) to confirm it is genuinely
    // untouched. Reading as the owner is a deliberately stronger assertion
    // than a system-scope read: it proves the row is intact from the user
    // whose tenancy axis governs it, not merely visible to the privileged
    // system context (which the policy now also permits).
    const actual = await withDbAccessContext(userContext(userAId), async () =>
      db
        .select({ id: approvalRequests.id, status: approvalRequests.status })
        .from(approvalRequests)
        .where(eq(approvalRequests.id, approvalAId!))
    );
    expect(actual).toHaveLength(1);
    expect(actual[0]!.status).toBe('pending');
  });

  it('user B INSERT with user_id=A is rejected by WITH CHECK', async () => {
    await ensureFixtures();

    let caught: unknown;
    try {
      await withDbAccessContext(userContext(userBId), async () =>
        db.insert(approvalRequests).values({
          userId: userAId, // forging user A's id while in user B's context
          requestingClientLabel: 'rls-forge-client',
          actionLabel: 'forge.test.crossuser',
          actionToolName: 'forge.test',
          riskTier: 'low',
          riskSummary: 'rls forge test cross-user insert',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        })
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string }; message?: string } | undefined);
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(
      /new row violates row-level security policy for table "approval_requests"/
    );
  });
});

// ===========================================================================
// manifest_signing_keys RLS lockout (#639)
//
// The catalog test above only proves `manifest_signing_keys` is in
// INTENTIONAL_UNSCOPED as documentation. It does NOT prove Postgres rejects
// a tenant-scoped (non-system) caller's INSERT/SELECT. This block forges
// both as `breeze_app` running under a normal tenant context and asserts
// the table is locked down by FORCE ROW LEVEL SECURITY with no permissive
// policies; the system-scope branch confirms the write path that
// ensureActiveSigningKey relies on still works.
// ===========================================================================
describe('manifest_signing_keys RLS — system-only enforcement (#639)', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const insertedKeyIds: string[] = [];

  // Build a tenant-scoped DbAccessContext that grants no orgs / no partners.
  // Under this context, breeze_app should be unable to touch
  // manifest_signing_keys — the table has ENABLE + FORCE RLS and no
  // permissive policies, so only the system context branch (which bypasses
  // RLS via runOutsideDbContext + withSystemDbAccessContext) can read/write.
  const tenantCtx = {
    scope: 'organization' as const,
    orgId: null,
    accessibleOrgIds: [],
    accessiblePartnerIds: [],
    userId: null,
  };

  afterAll(async () => {
    if (insertedKeyIds.length === 0) return;
    await withSystemDbAccessContext(async () => {
      for (const keyId of insertedKeyIds) {
        await db
          .delete(manifestSigningKeys)
          .where(eq(manifestSigningKeys.keyId, keyId));
      }
    });
  });

  it.runIf(!!process.env.DATABASE_URL)(
    'INSERT as breeze_app under a tenant context is rejected by RLS',
    async () => {
      let caught: unknown;
      try {
        await withDbAccessContext(tenantCtx, async () =>
          db.insert(manifestSigningKeys).values({
            keyId: `rls-forge-deny-${runSuffix}`,
            publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            privateKeyEnc: 'enc:v1:forge',
            status: 'active',
          }),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const cause = caught as
        | { cause?: { message?: string }; message?: string }
        | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      // Two acceptable rejection surfaces: a row-level-security policy
      // denial (USING/WITH CHECK on a permissive policy) or a permission
      // denied on the relation (no policy = no access by default once
      // FORCE RLS is on for the table's owner-equivalents too).
      expect(message).toMatch(
        /row-level security|permission denied|new row violates row-level security/i,
      );
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    'SELECT as breeze_app under a tenant context returns zero rows',
    async () => {
      // Seed a row via system context so there's something to fail to see.
      const seededKeyId = `rls-forge-seed-${runSuffix}`;
      await withSystemDbAccessContext(async () => {
        await db.insert(manifestSigningKeys).values({
          keyId: seededKeyId,
          publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          privateKeyEnc: 'enc:v1:forge',
          status: 'active',
        });
      });
      insertedKeyIds.push(seededKeyId);

      // Now read under a tenant context. RLS with no permissive policy
      // means the SELECT returns 0 rows OR Postgres throws permission
      // denied — assert either outcome explicitly.
      let rows: unknown[] = [];
      let err: unknown = null;
      try {
        rows = await withDbAccessContext(tenantCtx, async () =>
          db
            .select({ keyId: manifestSigningKeys.keyId })
            .from(manifestSigningKeys),
        );
      } catch (e) {
        err = e;
      }

      if (err) {
        const cause = err as
          | { cause?: { message?: string }; message?: string };
        const message = cause?.cause?.message ?? cause?.message ?? '';
        expect(message).toMatch(/permission denied|row-level security/i);
      } else {
        expect(rows).toEqual([]);
      }
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    'INSERT under system context succeeds',
    async () => {
      const keyId = `rls-forge-system-${runSuffix}`;
      const result = await withSystemDbAccessContext(async () => {
        return db
          .insert(manifestSigningKeys)
          .values({
            keyId,
            publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            privateKeyEnc: 'enc:v1:forge',
            status: 'retired',
          })
          .returning({ keyId: manifestSigningKeys.keyId });
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.keyId).toBe(keyId);
      insertedKeyIds.push(keyId);
    },
  );
});

// ===========================================================================
// partner_abuse_signals RLS lockout
//
// The catalog test above only proves partner_abuse_signals is in
// INTENTIONAL_UNSCOPED as documentation. It does NOT prove Postgres rejects
// a tenant-scoped (non-system) caller's INSERT/SELECT. This block forges
// both as `breeze_app`, including the specific threat this table exists to
// prevent: a partner reading abuse signals about ITSELF via a partner-scoped
// context whose accessiblePartnerIds includes the row's own partner_id. The
// system-scope branch confirms the abuse-signals sweep write path
// (services/abuseSignals/persistence.ts) still works.
// ===========================================================================
describe('partner_abuse_signals RLS — system-only enforcement', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partnerSlug = `rls-abuse-signals-partner-${runSuffix}`;

  let partnerId: string;
  const insertedSignalIds: string[] = [];

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `RLS Abuse Signals Partner ${runSuffix}`,
          slug: partnerSlug,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for abuse-signals RLS forge test');
      partnerId = partner.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      for (const id of insertedSignalIds) {
        await db.delete(partnerAbuseSignals).where(eq(partnerAbuseSignals.id, id));
      }
      if (partnerId) await db.delete(partners).where(eq(partners.id, partnerId));
    });
  });

  // Build a tenant-scoped (partner) DbAccessContext. Under this context,
  // breeze_app should be unable to touch partner_abuse_signals — the table
  // has ENABLE + FORCE RLS and a single system-only policy
  // (`partner_abuse_signals_system_only`, `USING current_setting
  // ('breeze.scope', true) = 'system'`), so only a caller whose session has
  // that GUC set to 'system' can read/write. `withSystemDbAccessContext`
  // does NOT bypass RLS — it still runs as the unprivileged `breeze_app`
  // role; it sets `breeze.scope = 'system'`, which is exactly what this
  // policy checks.
  function partnerContext(accessiblePartnerId: string) {
    return {
      scope: 'partner' as const,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [accessiblePartnerId],
      userId: null,
    };
  }

  it.runIf(!!process.env.DATABASE_URL)(
    'INSERT as breeze_app under a tenant (partner-scoped) context is rejected by RLS',
    async () => {
      await ensureFixtures();

      let caught: unknown;
      try {
        await withDbAccessContext(partnerContext(partnerId), async () =>
          db.insert(partnerAbuseSignals).values({
            partnerId,
            signalKey: `rls-forge-deny-${runSuffix}`,
            severity: 'watch',
            score: 1,
            evidence: {},
          }),
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeDefined();
      const cause = caught as
        | { cause?: { message?: string }; message?: string }
        | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/row-level security|permission denied/i);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "SELECT under a partner context matching the row's own partner_id returns zero rows",
    async () => {
      await ensureFixtures();

      // Seed a row via system context so there's something the partner
      // should fail to see — the specific threat this table exists to
      // prevent: a partner reading abuse signals about itself.
      const seededSignalKey = `rls-forge-seed-${runSuffix}`;
      const seeded = await withSystemDbAccessContext(async () => {
        return db
          .insert(partnerAbuseSignals)
          .values({
            partnerId,
            signalKey: seededSignalKey,
            severity: 'alert',
            score: 5,
            evidence: { note: 'rls forge seed' },
          })
          .returning({ id: partnerAbuseSignals.id });
      });
      expect(seeded).toHaveLength(1);
      insertedSignalIds.push(seeded[0]!.id);

      // Now read under a partner context whose accessiblePartnerIds
      // includes this exact partner — RLS with no permissive policy means
      // the SELECT returns 0 rows OR Postgres throws permission denied.
      let rows: unknown[] = [];
      let err: unknown = null;
      try {
        rows = await withDbAccessContext(partnerContext(partnerId), async () =>
          db
            .select({ id: partnerAbuseSignals.id })
            .from(partnerAbuseSignals)
            .where(eq(partnerAbuseSignals.partnerId, partnerId)),
        );
      } catch (e) {
        err = e;
      }

      if (err) {
        const cause = err as
          | { cause?: { message?: string }; message?: string };
        const message = cause?.cause?.message ?? cause?.message ?? '';
        expect(message).toMatch(/permission denied|row-level security/i);
      } else {
        expect(rows).toEqual([]);
      }
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    'withSystemDbAccessContext INSERT + SELECT round-trips successfully',
    async () => {
      await ensureFixtures();

      const signalKey = `rls-forge-system-${runSuffix}`;
      const result = await withSystemDbAccessContext(async () => {
        return db
          .insert(partnerAbuseSignals)
          .values({
            partnerId,
            signalKey,
            severity: 'info',
            score: 0.5,
            evidence: { note: 'system round-trip' },
          })
          .returning({ id: partnerAbuseSignals.id, signalKey: partnerAbuseSignals.signalKey });
      });
      expect(result).toHaveLength(1);
      expect(result[0]!.signalKey).toBe(signalKey);
      insertedSignalIds.push(result[0]!.id);

      const readBack = await withSystemDbAccessContext(async () => {
        return db
          .select({ id: partnerAbuseSignals.id })
          .from(partnerAbuseSignals)
          .where(eq(partnerAbuseSignals.id, result[0]!.id));
      });
      expect(readBack).toHaveLength(1);
    },
  );
});

// ===========================================================================
// automation_runs — parent-FK join-policy forge test (Shape 7, findings F2/F3)
//
// The pg_catalog assertion above only proves a parent-join policy exists per
// DML command. It does NOT prove Postgres actually hides another tenant's run.
// automation_runs WAS the F2/F3 finding: no org_id, no RLS, and the
// config-policy branch of GET /automations/runs/:runId returned the row with
// no org check. This block forges cross-org reads/writes as `breeze_app` (the
// unprivileged role) under real tenant contexts and asserts the new
// EXISTS-join policy is enforced in practice — the durable backstop behind the
// app-layer canAccessOrg fix in routes/automations.ts. Self-contained so it
// runs under vitest.config.rls-coverage.ts (no setup.ts / no TRUNCATE):
// fixtures are seeded via withSystemDbAccessContext and torn down by id.
// ===========================================================================
describe('automation_runs RLS — cross-org forge enforcement (Shape 7)', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let partnerId: string;
  let orgAId: string;
  let orgBId: string;
  let automationAId: string;
  let runAId: string | null = null;
  // Config-policy-driven run: automation_id is NULL, org reached via
  // config_policy_id -> configuration_policies.org_id (the F2/F3 leak path).
  let configPolicyAId: string;
  let configRunAId: string | null = null;

  // Org-scoped context granting access to exactly one org and nothing else,
  // so no other policy can accidentally green-light a cross-org row.
  function orgContext(orgId: string) {
    return {
      scope: 'organization' as const,
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      userId: null,
    };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `RLS AutoRuns Partner ${runSuffix}`,
          slug: `rls-autoruns-${runSuffix}`,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for automation_runs forge');
      partnerId = partner.id;

      const [orgA, orgB] = await db
        .insert(organizations)
        .values([
          { partnerId: partner.id, name: 'RLS AutoRuns Org A', slug: `rls-autoruns-a-${runSuffix}` },
          { partnerId: partner.id, name: 'RLS AutoRuns Org B', slug: `rls-autoruns-b-${runSuffix}` },
        ])
        .returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for automation_runs forge');
      orgAId = orgA.id;
      orgBId = orgB.id;

      const [automationA] = await db
        .insert(automations)
        .values({
          orgId: orgA.id,
          name: 'Org A automation',
          trigger: { type: 'manual' },
          actions: [],
        })
        .returning({ id: automations.id });
      if (!automationA) throw new Error('failed to seed automation for automation_runs forge');
      automationAId = automationA.id;

      const [runA] = await db
        .insert(automationRuns)
        .values({
          automationId: automationA.id,
          triggeredBy: 'rls-forge-test',
          status: 'completed',
        })
        .returning({ id: automationRuns.id });
      if (!runA) throw new Error('failed to seed automation_run for forge');
      runAId = runA.id;

      // Config-policy-driven run flavor (automation_id NULL): reaches its org
      // only via config_policy_id -> configuration_policies.org_id.
      const [policyA] = await db
        .insert(configurationPolicies)
        .values({ orgId: orgA.id, name: 'Org A config policy' })
        .returning({ id: configurationPolicies.id });
      if (!policyA) throw new Error('failed to seed configuration_policy for forge');
      configPolicyAId = policyA.id;

      const [configRunA] = await db
        .insert(automationRuns)
        .values({
          configPolicyId: policyA.id, // automationId intentionally left NULL
          configItemName: 'Org A config item',
          triggeredBy: 'rls-forge-test',
          status: 'completed',
        })
        .returning({ id: automationRuns.id });
      if (!configRunA) throw new Error('failed to seed config-policy automation_run for forge');
      configRunAId = configRunA.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      // Delete runs by automation_id (not just the seeded runAId) so a stray
      // run from a forged INSERT — which exists only when RLS is NOT yet
      // enforcing, i.e. a failing pre-migration run — can't block the parent
      // automation delete via FK.
      if (automationAId) {
        await db.delete(automationRuns).where(eq(automationRuns.automationId, automationAId));
      }
      if (automationAId) await db.delete(automations).where(eq(automations.id, automationAId));
      // Config-policy runs (automation_id NULL) aren't caught by the automationId
      // delete above; clear them + the policy before deleting the org (FK order).
      if (configPolicyAId) {
        await db.delete(automationRuns).where(eq(automationRuns.configPolicyId, configPolicyAId));
        await db.delete(configurationPolicies).where(eq(configurationPolicies.id, configPolicyAId));
      }
      if (orgAId) await db.delete(organizations).where(eq(organizations.id, orgAId));
      if (orgBId) await db.delete(organizations).where(eq(organizations.id, orgBId));
      if (partnerId) await db.delete(partners).where(eq(partners.id, partnerId));
    });
  });

  it.runIf(!!process.env.DATABASE_URL)(
    'org A (owner) can SELECT its own automation_run via the parent-join policy',
    async () => {
      await ensureFixtures();
      const rows = await withDbAccessContext(orgContext(orgAId), async () =>
        db
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(eq(automationRuns.id, runAId!)),
      );
      expect(rows.map((r) => r.id)).toEqual([runAId]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B cannot SELECT org A's automation_run (RLS hides it — the F2/F3 leak)",
    async () => {
      await ensureFixtures();
      if (!runAId) throw new Error('seed test must run first');
      const rows = await withDbAccessContext(orgContext(orgBId), async () =>
        db
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(eq(automationRuns.id, runAId!)),
      );
      expect(rows).toEqual([]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B INSERT referencing org A's automation is rejected by WITH CHECK",
    async () => {
      await ensureFixtures();
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(automationRuns).values({
            automationId: automationAId, // forging a run under another tenant's automation
            triggeredBy: 'rls-forge-test-crossorg',
            status: 'running',
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(
        /new row violates row-level security policy for table "automation_runs"/,
      );
    },
  );

  // --- config-policy-driven runs (automation_id NULL) — the F2/F3 branch ---
  it.runIf(!!process.env.DATABASE_URL)(
    'org A can SELECT its config-policy automation_run (config_policy_id reach)',
    async () => {
      await ensureFixtures();
      const rows = await withDbAccessContext(orgContext(orgAId), async () =>
        db
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(eq(automationRuns.id, configRunAId!)),
      );
      expect(rows.map((r) => r.id)).toEqual([configRunAId]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B cannot SELECT org A's config-policy automation_run (RLS hides it)",
    async () => {
      await ensureFixtures();
      if (!configRunAId) throw new Error('seed test must run first');
      const rows = await withDbAccessContext(orgContext(orgBId), async () =>
        db
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(eq(automationRuns.id, configRunAId!)),
      );
      expect(rows).toEqual([]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B INSERT referencing org A's config policy is rejected by WITH CHECK",
    async () => {
      await ensureFixtures();
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(automationRuns).values({
            configPolicyId: configPolicyAId, // forging a run under another tenant's config policy
            configItemName: 'forged',
            triggeredBy: 'rls-forge-test-crossorg-cp',
            status: 'running',
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(
        /new row violates row-level security policy for table "automation_runs"/,
      );
    },
  );
});

// ===========================================================================
// script_execution_batches RLS — denormalized org_id (2026-05-31 review fix)
//
// Batches carry a denormalized org_id (the executing org), so the policy is a
// direct breeze_has_org_access(org_id) — no nested-RLS join through the
// nullable-org `scripts` parent. This forge proves the two things the nested
// `is_system` join FAILED at under the production driver's bound-parameter
// INSERTs: (a) a tenant CAN insert a batch for a SYSTEM script under tenant
// context (org_id = its own org), and (b) cross-org isolation holds — org B
// cannot read org A's batch, and a forged cross-org INSERT is rejected.
// ===========================================================================
describe('script_execution_batches RLS — denormalized org_id', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let partnerId: string;
  let orgAId: string;
  let orgBId: string;
  let systemScriptId: string;
  let batchAId: string | null = null;

  function orgContext(orgId: string) {
    return {
      scope: 'organization' as const,
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      userId: null,
    };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `RLS Batches Partner ${runSuffix}`,
          slug: `rls-batches-${runSuffix}`,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for batches forge');
      partnerId = partner.id;

      const [orgA, orgB] = await db
        .insert(organizations)
        .values([
          { partnerId: partner.id, name: 'RLS Batches Org A', slug: `rls-batches-a-${runSuffix}` },
          { partnerId: partner.id, name: 'RLS Batches Org B', slug: `rls-batches-b-${runSuffix}` },
        ])
        .returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for batches forge');
      orgAId = orgA.id;
      orgBId = orgB.id;

      // A SYSTEM script (org_id NULL, is_system) — the case the nested-RLS join
      // could not handle. With denormalization the batch (not the script) holds
      // the executing org.
      const [systemScript] = await db
        .insert(scripts)
        .values({
          orgId: null,
          isSystem: true,
          name: 'System script',
          osTypes: ['windows'],
          language: 'powershell',
          content: 'echo sys',
        })
        .returning({ id: scripts.id });
      if (!systemScript) throw new Error('failed to seed system script for batches forge');
      systemScriptId = systemScript.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      if (systemScriptId) await db.delete(scriptExecutionBatches).where(eq(scriptExecutionBatches.scriptId, systemScriptId));
      if (systemScriptId) await db.delete(scripts).where(eq(scripts.id, systemScriptId));
      if (orgAId) await db.delete(organizations).where(eq(organizations.id, orgAId));
      if (orgBId) await db.delete(organizations).where(eq(organizations.id, orgBId));
      if (partnerId) await db.delete(partners).where(eq(partners.id, partnerId));
    });
  });

  it.runIf(!!process.env.DATABASE_URL)(
    'org A CAN INSERT a batch for a system script under tenant context (denormalized org_id; bound-parameter INSERT now works)',
    async () => {
      await ensureFixtures();
      const inserted = await withDbAccessContext(orgContext(orgAId), async () =>
        db
          .insert(scriptExecutionBatches)
          .values({ scriptId: systemScriptId, orgId: orgAId, devicesTargeted: 2, status: 'pending' })
          .returning({ id: scriptExecutionBatches.id }),
      );
      expect(inserted).toHaveLength(1);
      batchAId = inserted[0]!.id;
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org A SELECTs its own batch; org B cannot (cross-org isolation)",
    async () => {
      await ensureFixtures();
      if (!batchAId) throw new Error('insert test must run first');
      const a = await withDbAccessContext(orgContext(orgAId), async () =>
        db.select({ id: scriptExecutionBatches.id }).from(scriptExecutionBatches).where(eq(scriptExecutionBatches.id, batchAId!)),
      );
      expect(a.map((r) => r.id)).toEqual([batchAId]);
      const b = await withDbAccessContext(orgContext(orgBId), async () =>
        db.select({ id: scriptExecutionBatches.id }).from(scriptExecutionBatches).where(eq(scriptExecutionBatches.id, batchAId!)),
      );
      expect(b).toEqual([]);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    "org B INSERT with org_id = org A is rejected by WITH CHECK",
    async () => {
      await ensureFixtures();
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(scriptExecutionBatches).values({ scriptId: systemScriptId, orgId: orgAId, devicesTargeted: 2, status: 'pending' }),
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/new row violates row-level security policy for table "script_execution_batches"/);
    },
  );
});

// ===========================================================================
// scripts RLS — partner-wide cross-partner forge enforcement (dual-axis)
//
// The pg_catalog assertion for the PARTNER_TENANT_TABLES list proves that
// a policy referencing breeze_has_partner_access exists per DML command.
// It does NOT prove Postgres actually rejects a cross-partner write — a
// missing second axis (the custom_field_definitions blind spot) would pass
// the catalog check but silently let partner B act on partner A's partner-
// wide scripts. This block forges cross-partner reads/writes as `breeze_app`
// under real partner contexts and asserts the dual-axis policy is enforced
// in practice. Self-contained (no setup.ts / no TRUNCATE): fixtures seeded
// via withSystemDbAccessContext and torn down by id in an afterAll.
// ===========================================================================
describe('scripts RLS — partner-wide cross-partner forge enforcement (dual-axis)', () => {
  const runSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let partnerAId: string;
  let partnerBId: string;
  // An organization owned by partner A. Used to prove that an ORGANIZATION-
  // scope user (accessiblePartnerIds === []) can still READ partner A's
  // partner-wide scripts via the read-only own-partner branch
  // (breeze_current_partner_id), without gaining write access.
  let orgInPartnerAId: string;
  let scriptAId: string | null = null;

  async function ensureFixtures(): Promise<void> {
    if (partnerAId) return;
    await withSystemDbAccessContext(async () => {
      const seeded = await db.insert(partners).values([
        { name: `RLS Scripts A ${runSuffix}`, slug: `rls-scripts-a-${runSuffix}`, type: 'msp', plan: 'pro', status: 'active' },
        { name: `RLS Scripts B ${runSuffix}`, slug: `rls-scripts-b-${runSuffix}`, type: 'msp', plan: 'pro', status: 'active' },
      ]).returning({ id: partners.id });
      partnerAId = seeded[0]!.id;
      partnerBId = seeded[1]!.id;

      const [org] = await db.insert(organizations).values({
        partnerId: partnerAId,
        name: `RLS Scripts Org ${runSuffix}`,
        slug: `rls-scripts-org-${runSuffix}`,
      }).returning({ id: organizations.id });
      orgInPartnerAId = org!.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      if (scriptAId) await db.delete(scripts).where(eq(scripts.id, scriptAId!));
      if (orgInPartnerAId) await db.delete(organizations).where(eq(organizations.id, orgInPartnerAId));
      if (partnerAId) await db.delete(partners).where(eq(partners.id, partnerAId));
      if (partnerBId) await db.delete(partners).where(eq(partners.id, partnerBId));
    });
  });

  function partnerContext(partnerId: string) {
    return { scope: 'partner' as const, orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId: null };
  }

  // ORGANIZATION-scope context: accessiblePartnerIds is [] (no partner-axis
  // WRITE/admin), but currentPartnerId = the caller's OWN partner so the
  // read-only own-partner branch of the SELECT policy applies.
  function orgContext(orgId: string, ownPartnerId: string | null) {
    return {
      scope: 'organization' as const,
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      currentPartnerId: ownPartnerId,
      userId: null,
    };
  }

  it('partner A can INSERT and SELECT a partner-wide (org_id NULL) script', async () => {
    await ensureFixtures();
    const inserted = await withDbAccessContext(partnerContext(partnerAId), async () =>
      db.insert(scripts).values({
        orgId: null, partnerId: partnerAId, name: `forge-${runSuffix}`,
        osTypes: ['windows'], language: 'powershell', content: 'echo hi',
      }).returning({ id: scripts.id })
    );
    expect(inserted).toHaveLength(1);
    scriptAId = inserted[0]!.id;

    const visibleToA = await withDbAccessContext(partnerContext(partnerAId), async () =>
      db.select({ id: scripts.id }).from(scripts).where(eq(scripts.id, scriptAId!))
    );
    expect(visibleToA.map((r) => r.id)).toEqual([scriptAId]);
  });

  it('partner B cannot SELECT partner A\'s partner-wide script', async () => {
    await ensureFixtures();
    if (!scriptAId) throw new Error('seed test must run first');
    const visibleToB = await withDbAccessContext(partnerContext(partnerBId), async () =>
      db.select({ id: scripts.id }).from(scripts).where(eq(scripts.id, scriptAId!))
    );
    expect(visibleToB).toEqual([]);
  });

  it('partner B INSERT forging partner A\'s partner_id is rejected by WITH CHECK', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(partnerContext(partnerBId), async () =>
        db.insert(scripts).values({
          orgId: null, partnerId: partnerAId, name: `forge-x-${runSuffix}`,
          osTypes: ['windows'], language: 'powershell', content: 'echo x',
        })
      );
    } catch (err) { caught = err; }
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "scripts"/);
  });

  // --- read-only own-partner branch: an ORGANIZATION-scope user (no partner-
  // axis write access) can SEE + EXECUTE its MSP's partner-wide scripts but
  // cannot edit them, and a different partner's org user still cannot see them.
  it('org user in partner A CAN SELECT partner A\'s partner-wide script (read branch)', async () => {
    await ensureFixtures();
    if (!scriptAId) throw new Error('seed test must run first');
    const visible = await withDbAccessContext(orgContext(orgInPartnerAId, partnerAId), async () =>
      db.select({ id: scripts.id }).from(scripts).where(eq(scripts.id, scriptAId!))
    );
    expect(visible.map((r) => r.id)).toEqual([scriptAId]);
  });

  it('org user in partner A UPDATE on the partner-wide script affects 0 rows (write policy unchanged)', async () => {
    await ensureFixtures();
    if (!scriptAId) throw new Error('seed test must run first');
    // USING on the UPDATE policy does NOT include the read branch, so the row
    // is invisible to the write path and the UPDATE matches nothing.
    const updated = await withDbAccessContext(orgContext(orgInPartnerAId, partnerAId), async () =>
      db.update(scripts).set({ name: `edited-by-org-${runSuffix}` }).where(eq(scripts.id, scriptAId!)).returning({ id: scripts.id })
    );
    expect(updated).toEqual([]);

    // And the row is untouched.
    const after = await withDbAccessContext(partnerContext(partnerAId), async () =>
      db.select({ name: scripts.name }).from(scripts).where(eq(scripts.id, scriptAId!))
    );
    expect(after[0]?.name).toBe(`forge-${runSuffix}`);
  });

  it('org user in partner A forging a partner-wide INSERT is rejected by WITH CHECK (write policy unchanged)', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgInPartnerAId, partnerAId), async () =>
        db.insert(scripts).values({
          orgId: null, partnerId: partnerAId, name: `org-forge-${runSuffix}`,
          osTypes: ['windows'], language: 'powershell', content: 'echo org',
        })
      );
    } catch (err) { caught = err; }
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "scripts"/);
  });

  it('org user whose own partner is B CANNOT SELECT partner A\'s partner-wide script (cross-partner isolation)', async () => {
    await ensureFixtures();
    if (!scriptAId) throw new Error('seed test must run first');
    // Same org row, but currentPartnerId points at partner B — the read branch
    // (org_id IS NULL AND partner_id = current_partner_id) does not match.
    const visible = await withDbAccessContext(orgContext(orgInPartnerAId, partnerBId), async () =>
      db.select({ id: scripts.id }).from(scripts).where(eq(scripts.id, scriptAId!))
    );
    expect(visible).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// invoices — shape 1 (direct/denormalized org_id) forge test
// ---------------------------------------------------------------------------
// invoices, invoice_lines, invoice_payments all carry a direct org_id column
// and are auto-discovered by the coverage scan above. This block forges a
// cross-org INSERT and SELECT as `breeze_app` (the unprivileged role) to prove
// the WITH CHECK / USING predicates actually contain a hostile write/read.
describe('invoices RLS forge (shape 1, org-axis)', () => {
  const runSuffix = Math.random().toString(36).slice(2, 8);
  let partnerId = '';
  let orgAId = '';
  let orgBId = '';

  function orgContext(orgId: string) {
    return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db.insert(partners).values({
        name: `RLS Invoices Partner ${runSuffix}`, slug: `rls-invoices-${runSuffix}`,
        type: 'msp', plan: 'pro', status: 'active'
      }).returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for invoices forge');
      partnerId = partner.id;
      const [orgA, orgB] = await db.insert(organizations).values([
        { partnerId: partner.id, name: 'RLS Invoices Org A', slug: `rls-inv-a-${runSuffix}` },
        { partnerId: partner.id, name: 'RLS Invoices Org B', slug: `rls-inv-b-${runSuffix}` }
      ]).returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for invoices forge');
      orgAId = orgA.id; orgBId = orgB.id;
    });
  }

  it.runIf(!!process.env.DATABASE_URL)('org B INSERT with org A org_id is rejected by WITH CHECK', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(invoices).values({ partnerId, orgId: orgAId, status: 'draft' })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "invoices"/);
  });

  it.runIf(!!process.env.DATABASE_URL)("org B cannot SELECT org A's invoice", async () => {
    await ensureFixtures();
    let createdId = '';
    await withSystemDbAccessContext(async () => {
      const [inv] = await db.insert(invoices).values({ partnerId, orgId: orgAId, status: 'draft' }).returning({ id: invoices.id });
      createdId = inv!.id;
    });
    const visible = await withDbAccessContext(orgContext(orgBId), async () =>
      db.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, createdId))
    );
    expect(visible).toHaveLength(0);
  });

  // Defense-in-depth: the composite FK invoice_lines(invoice_id, org_id) →
  // invoices(id, org_id) must reject a line whose denormalized org_id disagrees
  // with its parent invoice's org_id. Run in SYSTEM context so RLS is bypassed
  // and the FK is unambiguously what rejects the write.
  it.runIf(!!process.env.DATABASE_URL)('invoice line with mismatched org_id is rejected by the composite FK', async () => {
    await ensureFixtures();
    // Create the parent invoice (orgA) in its own system-context transaction so
    // it is committed before we attempt the forged line.
    let invoiceId = '';
    await withSystemDbAccessContext(async () => {
      const [inv] = await db.insert(invoices).values({ partnerId, orgId: orgAId, status: 'draft' }).returning({ id: invoices.id });
      invoiceId = inv!.id;
    });
    // The FK violation aborts the surrounding transaction, so postgres.js may
    // surface the error at commit time — catch around the whole context call.
    let caught: unknown;
    try {
      await withSystemDbAccessContext(async () =>
        // invoice belongs to orgA, but we forge a line claiming orgB.
        db.insert(invoiceLines).values({
          invoiceId, orgId: orgBId, sourceType: 'manual',
          description: 'forged mismatched-org line', quantity: '1', unitPrice: '0'
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/violates foreign key constraint|invoice_lines_invoice_org_fkey/);
  });
});

// ---------------------------------------------------------------------------
// contracts, contract_lines, contract_billing_periods — shape 1 (direct org_id)
// ---------------------------------------------------------------------------
// All three tables carry a direct org_id column and are auto-discovered by the
// coverage scan above. This block forges cross-org INSERTs and SELECTs as
// `breeze_app` (the unprivileged role) to prove the WITH CHECK / USING
// predicates actually reject hostile writes/reads. Self-contained: fixtures
// are seeded via withSystemDbAccessContext (no setup.ts TRUNCATE here).
describe('contracts RLS forge (shape 1, org-axis)', () => {
  const runSuffix = Math.random().toString(36).slice(2, 8);
  let partnerId = '';
  let orgAId = '';
  let orgBId = '';
  // Org-A contract seeded for line/period cross-org attempts.
  let contractAId = '';

  function orgContext(orgId: string) {
    return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db.insert(partners).values({
        name: `RLS Contracts Partner ${runSuffix}`, slug: `rls-contracts-${runSuffix}`,
        type: 'msp', plan: 'pro', status: 'active'
      }).returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for contracts forge');
      partnerId = partner.id;
      const [orgA, orgB] = await db.insert(organizations).values([
        { partnerId: partner.id, name: 'RLS Contracts Org A', slug: `rls-ctr-a-${runSuffix}` },
        { partnerId: partner.id, name: 'RLS Contracts Org B', slug: `rls-ctr-b-${runSuffix}` }
      ]).returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for contracts forge');
      orgAId = orgA.id; orgBId = orgB.id;
      // Seed an org-A contract so we can hang line/period cross-org attempts on it.
      const [c] = await db.insert(contracts).values({
        partnerId: partner.id, orgId: orgAId, name: 'forge-seed',
        intervalMonths: 1, startDate: '2026-07-01'
      }).returning({ id: contracts.id });
      if (!c) throw new Error('failed to seed contract for contracts forge');
      contractAId = c.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      if (contractAId) await db.delete(contracts).where(eq(contracts.id, contractAId));
      if (orgAId) await db.delete(organizations).where(eq(organizations.id, orgAId));
      if (orgBId) await db.delete(organizations).where(eq(organizations.id, orgBId));
      if (partnerId) await db.delete(partners).where(eq(partners.id, partnerId));
    });
  });

  it.runIf(!!process.env.DATABASE_URL)('org B INSERT with org A org_id is rejected by WITH CHECK (contracts)', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(contracts).values({
          partnerId, orgId: orgAId, name: 'forge-crossorg',
          intervalMonths: 1, startDate: '2026-07-01'
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "contracts"/);
  });

  it.runIf(!!process.env.DATABASE_URL)("org B cannot SELECT org A's contract", async () => {
    await ensureFixtures();
    const visible = await withDbAccessContext(orgContext(orgBId), async () =>
      db.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, contractAId))
    );
    expect(visible).toHaveLength(0);
  });

  it.runIf(!!process.env.DATABASE_URL)('org B INSERT with org A org_id is rejected by WITH CHECK (contract_lines)', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(contractLines).values({
          contractId: contractAId, orgId: orgAId,
          lineType: 'flat', description: 'forge-crossorg', unitPrice: '0'
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "contract_lines"/);
  });

  it.runIf(!!process.env.DATABASE_URL)('org B INSERT with org A org_id is rejected by WITH CHECK (contract_billing_periods)', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(contractBillingPeriods).values({
          contractId: contractAId, orgId: orgAId,
          periodStart: '2026-07-01', periodEnd: '2026-08-01'
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "contract_billing_periods"/);
  });
});

// ---------------------------------------------------------------------------
// invoice_documents — shape 1 (direct/denormalized org_id) forge test (Phase 5)
// ---------------------------------------------------------------------------
// invoice_documents carries a direct org_id column (denormalized RLS axis) and
// is auto-discovered by the coverage scan above. This block forges a cross-org
// INSERT and SELECT as `breeze_app` to prove the policies contain a hostile
// write/read, mirroring the invoices forge.
describe('invoice_documents RLS forge (shape 1, org-axis)', () => {
  const runSuffix = Math.random().toString(36).slice(2, 8);
  let partnerId = '';
  let orgAId = '';
  let orgBId = '';
  let invoiceAId = '';

  function orgContext(orgId: string) {
    return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db.insert(partners).values({
        name: `RLS InvDocs Partner ${runSuffix}`, slug: `rls-invdocs-${runSuffix}`,
        type: 'msp', plan: 'pro', status: 'active'
      }).returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for invoice_documents forge');
      partnerId = partner.id;
      const [orgA, orgB] = await db.insert(organizations).values([
        { partnerId: partner.id, name: 'RLS InvDocs Org A', slug: `rls-invdocs-a-${runSuffix}` },
        { partnerId: partner.id, name: 'RLS InvDocs Org B', slug: `rls-invdocs-b-${runSuffix}` }
      ]).returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for invoice_documents forge');
      orgAId = orgA.id; orgBId = orgB.id;
      const [inv] = await db.insert(invoices).values({ partnerId, orgId: orgAId, status: 'draft' }).returning({ id: invoices.id });
      invoiceAId = inv!.id;
    });
  }

  it.runIf(!!process.env.DATABASE_URL)("org B cannot INSERT a document for org A's invoice", async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(invoiceDocuments).values({
          invoiceId: invoiceAId, orgId: orgAId, pdf: Buffer.from('%PDF-forged'), sha256: 'a'.repeat(64)
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "invoice_documents"/);
  });

  it.runIf(!!process.env.DATABASE_URL)("org B cannot SELECT org A's invoice document", async () => {
    await ensureFixtures();
    let createdId = '';
    await withSystemDbAccessContext(async () => {
      const [doc] = await db.insert(invoiceDocuments).values({
        invoiceId: invoiceAId, orgId: orgAId, pdf: Buffer.from('%PDF-stored'), sha256: 'b'.repeat(64)
      }).returning({ id: invoiceDocuments.id });
      createdId = doc!.id;
    });
    const visible = await withDbAccessContext(orgContext(orgBId), async () =>
      db.select({ id: invoiceDocuments.id }).from(invoiceDocuments).where(eq(invoiceDocuments.id, createdId))
    );
    expect(visible).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ml_feedback_events — shape 1 (direct org_id) forge test
// ---------------------------------------------------------------------------
// ml_feedback_events is the canonical append-only ML label table. It carries a
// direct org_id and is auto-discovered by the coverage scan above; this block
// proves hostile cross-org INSERT/SELECT attempts are blocked under breeze_app.
describe('ml_feedback_events RLS forge (shape 1, org-axis)', () => {
  const runSuffix = Math.random().toString(36).slice(2, 8);
  let partnerId = '';
  let orgAId = '';
  let orgBId = '';

  function orgContext(orgId: string) {
    return { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db.insert(partners).values({
        name: `RLS ML Feedback Partner ${runSuffix}`, slug: `rls-ml-feedback-${runSuffix}`,
        type: 'msp', plan: 'pro', status: 'active'
      }).returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for ml_feedback_events forge');
      partnerId = partner.id;
      const [orgA, orgB] = await db.insert(organizations).values([
        { partnerId: partner.id, name: 'RLS ML Feedback Org A', slug: `rls-ml-feedback-a-${runSuffix}` },
        { partnerId: partner.id, name: 'RLS ML Feedback Org B', slug: `rls-ml-feedback-b-${runSuffix}` }
      ]).returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for ml_feedback_events forge');
      orgAId = orgA.id; orgBId = orgB.id;
    });
  }

  it.runIf(!!process.env.DATABASE_URL)('org B INSERT with org A org_id is rejected by WITH CHECK', async () => {
    await ensureFixtures();
    let caught: unknown;
    try {
      await withDbAccessContext(orgContext(orgBId), async () =>
        db.insert(mlFeedbackEvents).values({
          orgId: orgAId,
          sourceType: 'alert',
          sourceId: `alert-${runSuffix}`,
          eventType: 'alert.acknowledged',
          outcome: 'acknowledged',
          metadata: {},
          occurredAt: new Date('2026-06-18T12:00:00.000Z'),
        })
      );
    } catch (err) { caught = err; }
    expect(caught).toBeDefined();
    const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
    const message = cause?.cause?.message ?? cause?.message ?? '';
    expect(message).toMatch(/new row violates row-level security policy for table "ml_feedback_events"/);
  });

  it.runIf(!!process.env.DATABASE_URL)("org B cannot SELECT org A's feedback event", async () => {
    await ensureFixtures();
    let createdId = '';
    await withSystemDbAccessContext(async () => {
      const [event] = await db.insert(mlFeedbackEvents).values({
        orgId: orgAId,
        sourceType: 'alert',
        sourceId: `alert-visible-${runSuffix}`,
        eventType: 'alert.resolved',
        outcome: 'resolved',
        metadata: {},
        occurredAt: new Date('2026-06-18T12:01:00.000Z'),
      }).returning({ id: mlFeedbackEvents.id });
      createdId = event!.id;
    });
    const visible = await withDbAccessContext(orgContext(orgBId), async () =>
      db.select({ id: mlFeedbackEvents.id }).from(mlFeedbackEvents).where(eq(mlFeedbackEvents.id, createdId))
    );
    expect(visible).toHaveLength(0);
  });
});

// ===========================================================================
// unifi_integrations — partner-axis forge test (Shape 3)
//
// unifi_integrations is partner-scoped: each MSP partner holds its own UniFi
// API credential. The policy uses breeze_has_partner_access(partner_id).
// This block proves Postgres rejects a cross-partner INSERT under breeze_app:
// partner B's context cannot forge a row with partner_id = partner A.
// Self-contained (no TRUNCATE dependency): fixtures seeded via
// withSystemDbAccessContext and torn down in afterAll.
// ===========================================================================
describe('unifi_integrations RLS — cross-partner forge enforcement (Shape 3)', () => {
  const runSuffix = Math.random().toString(36).slice(2, 8);

  let partnerAId = '';
  let partnerBId = '';

  // Partner-scoped context: grants access to exactly one partner and no orgs,
  // so no other policy can accidentally green-light the forged row.
  function partnerContext(partnerId: string) {
    return {
      scope: 'partner' as const,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [partnerId],
      userId: null,
    };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerAId) return;
    await withSystemDbAccessContext(async () => {
      const [a, b] = await db
        .insert(partners)
        .values([
          {
            name: `RLS UniFi Partner A ${runSuffix}`,
            slug: `rls-unifi-a-${runSuffix}`,
            type: 'msp',
            plan: 'pro',
            status: 'active',
          },
          {
            name: `RLS UniFi Partner B ${runSuffix}`,
            slug: `rls-unifi-b-${runSuffix}`,
            type: 'msp',
            plan: 'pro',
            status: 'active',
          },
        ])
        .returning({ id: partners.id });
      if (!a || !b) throw new Error('failed to seed partners for unifi_integrations forge test');
      partnerAId = a.id;
      partnerBId = b.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      if (partnerAId) {
        await db.delete(unifiIntegrations).where(eq(unifiIntegrations.partnerId, partnerAId));
        await db.delete(partners).where(eq(partners.id, partnerAId));
      }
      if (partnerBId) {
        await db.delete(unifiIntegrations).where(eq(unifiIntegrations.partnerId, partnerBId));
        await db.delete(partners).where(eq(partners.id, partnerBId));
      }
    });
  });

  it.runIf(!!process.env.DATABASE_URL)(
    'partner B INSERT into unifi_integrations with partner_id=A is rejected by RLS',
    async () => {
      await ensureFixtures();
      let caught: unknown;
      try {
        await withDbAccessContext(partnerContext(partnerBId), async () =>
          db.insert(unifiIntegrations).values({
            partnerId: partnerAId, // forging partner A while in partner B's context
            apiKeyEncrypted: 'rls-forge-not-a-real-key',
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/row-level security/i);
    },
  );
});

// ===========================================================================
// unifi_devices — org-axis forge test (Shape 1)
//
// unifi_devices carries a direct org_id column (Shape 1, auto-discovered).
// Its policy uses breeze_has_org_access(org_id). This block proves Postgres
// rejects a cross-org INSERT under breeze_app: org B's context cannot forge
// a row with org_id = org A. The RLS WITH CHECK on org_id fires before FK
// evaluation, so referenced integration/mapping/site ids need not exist.
// Self-contained: fixtures seeded via withSystemDbAccessContext, torn down
// in afterAll.
// ===========================================================================
describe('unifi_devices RLS — cross-org forge enforcement (Shape 1)', () => {
  const runSuffix = Math.random().toString(36).slice(2, 8);

  let partnerId = '';
  let orgAId = '';
  let orgBId = '';
  let orgASiteId = '';

  function orgContext(orgId: string) {
    return {
      scope: 'organization' as const,
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      userId: null,
    };
  }

  async function ensureFixtures(): Promise<void> {
    if (partnerId) return;
    await withSystemDbAccessContext(async () => {
      const [partner] = await db
        .insert(partners)
        .values({
          name: `RLS UniFi Devices Partner ${runSuffix}`,
          slug: `rls-unifi-dev-${runSuffix}`,
          type: 'msp',
          plan: 'pro',
          status: 'active',
        })
        .returning({ id: partners.id });
      if (!partner) throw new Error('failed to seed partner for unifi_devices forge test');
      partnerId = partner.id;

      const [orgA, orgB] = await db
        .insert(organizations)
        .values([
          { partnerId: partner.id, name: 'RLS UniFi Devices Org A', slug: `rls-unifi-dev-a-${runSuffix}` },
          { partnerId: partner.id, name: 'RLS UniFi Devices Org B', slug: `rls-unifi-dev-b-${runSuffix}` },
        ])
        .returning({ id: organizations.id });
      if (!orgA || !orgB) throw new Error('failed to seed orgs for unifi_devices forge test');
      orgAId = orgA.id;
      orgBId = orgB.id;

      const [siteA] = await db
        .insert(sites)
        .values({ orgId: orgA.id, name: 'RLS UniFi Devices Site A' })
        .returning({ id: sites.id });
      if (!siteA) throw new Error('failed to seed org A site for unifi_devices forge test');
      orgASiteId = siteA.id;
    });
  }

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      if (orgASiteId) await db.delete(sites).where(eq(sites.id, orgASiteId));
      if (orgAId) await db.delete(organizations).where(eq(organizations.id, orgAId));
      if (orgBId) await db.delete(organizations).where(eq(organizations.id, orgBId));
      if (partnerId) await db.delete(partners).where(eq(partners.id, partnerId));
    });
  });

  it.runIf(!!process.env.DATABASE_URL)(
    'org B INSERT into unifi_devices with org_id=A is rejected by RLS',
    async () => {
      await ensureFixtures();
      // Phantom UUIDs: RLS WITH CHECK on org_id fires before FK evaluation,
      // so these do not need to reference real rows.
      const phantomId = '00000000-0000-0000-0000-000000000001';
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(unifiDevices).values({
            orgId: orgAId, // forging org A while in org B's context
            siteId: phantomId,
            integrationId: phantomId,
            mappingId: phantomId,
            unifiDeviceId: 'forge-device',
            raw: {},
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/row-level security/i);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    'org B INSERT into unifi_collectors with org_id=A is rejected by RLS',
    async () => {
      await ensureFixtures();
      const phantomId = '00000000-0000-0000-0000-000000000001';
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(unifiCollectors).values({
            integrationId: phantomId,
            orgId: orgAId, // forging org A while in org B's context
            siteId: orgASiteId,
            unifiHostId: 'forge-host',
            collectorDeviceId: phantomId,
            controllerUrl: 'https://10.0.0.1',
            localApiKeyEncrypted: 'rls-forge-not-a-real-key',
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/row-level security/i);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    'org B INSERT into unifi_device_telemetry with org_id=A is rejected by RLS',
    async () => {
      await ensureFixtures();
      const phantomId = '00000000-0000-0000-0000-000000000001';
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(unifiDeviceTelemetry).values({
            collectorId: phantomId,
            orgId: orgAId,
            siteId: orgASiteId,
            unifiDeviceId: 'forge-dev',
            raw: {},
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/row-level security/i);
    },
  );

  it.runIf(!!process.env.DATABASE_URL)(
    'org B INSERT into unifi_clients with org_id=A is rejected by RLS',
    async () => {
      await ensureFixtures();
      const phantomId = '00000000-0000-0000-0000-000000000001';
      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgBId), async () =>
          db.insert(unifiClients).values({
            collectorId: phantomId,
            orgId: orgAId,
            siteId: orgASiteId,
            mac: 'aa:bb:cc:00:11:22',
            raw: {},
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const cause = caught as { cause?: { message?: string }; message?: string } | undefined;
      const message = cause?.cause?.message ?? cause?.message ?? '';
      expect(message).toMatch(/row-level security/i);
    },
  );
});
