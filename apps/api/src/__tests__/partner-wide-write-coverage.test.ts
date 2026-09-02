/**
 * CONTRACT TEST — every caller-facing write to partner-wide state must consult
 * `canManagePartnerWidePolicies` (epic #2135).
 *
 * Why this file exists: the security review of 2026-08-16 (§1.1) found SIX
 * independent write sites that gated on `scope` and never on the CAPABILITY —
 * custom fields, the approval-assurance floor, update rings (route + AI tool),
 * AI prompt templates, alert templates, and partner service principals (which
 * mint partner-wide MACHINE CREDENTIALS). Human code review had caught 0 of
 * them across six separate PRs. That is exactly the failure profile the cascade
 * lists and RLS coverage already answer mechanically, so this answers it the
 * same way.
 *
 * The rule, and it is deliberately blunt:
 *
 *   A file under `src/routes/**` or `src/services/**` that mutates a
 *   PARTNER-AXIS table must mention `canManagePartnerWidePolicies` or carry a
 *   documented allowlist exemption.
 *
 * The walk originally covered routes + aiTools only; it was extended to all of
 * services/ on 2026-08-23 after BOTH real instances of this bug class
 * (partnerLlmConfig.ts, partnerStripe.ts) turned out to live in services the
 * walk never saw — the mutation sits in a service, the gate in its route, and
 * the guard read neither.
 *
 * "Partner-axis table" is derived from the live Drizzle schema, never
 * hand-listed: any table with a `partner_id` column whose `org_id` is absent or
 * NULLABLE can hold a row that belongs to the partner rather than to one org —
 * i.e. a row that pushes state into every org under the MSP, including orgs
 * created later. `org_id NOT NULL` tables cannot express that and are skipped.
 *
 * Scope is limited to routes + AI tools on purpose: those are the surfaces a
 * human or an agent can reach with a token. Workers, jobs, seeds and background
 * services run in a system context with no caller to gate, and enumerating them
 * would drown the signal.
 *
 * The check is textual (does the file mention the helper?), not semantic — it
 * cannot prove the gate is placed correctly, only that the author was made to
 * think about it. Per-route tests assert the 403 actually fires. A grep-level
 * guard that fires 6/6 is worth far more than a clever one that ships.
 *
 * Adding a file here: FIRST convince yourself the write genuinely cannot create
 * or modify a partner-owned row from a caller's request. Then add it to
 * ALLOWED_WITHOUT_CAPABILITY_CHECK with a reason. An entry with no reason is a
 * bug you have not found yet.
 *
 * Plain unit test — reads the Drizzle schema objects and the source tree. No
 * database, so it runs in the `test-api` job where a stale base still fails.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { getTableColumns, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';

const CAPABILITY_FN = 'canManagePartnerWidePolicies';
const API_SRC = resolve(__dirname, '..');

/**
 * Files that mutate a partner-axis table but legitimately do not need the
 * partner-wide capability gate. Every entry carries the reason it is exempt.
 */
const ALLOWED_WITHOUT_CAPABILITY_CHECK: Record<string, string> = {
  // --- `users` is dual-axis (shape 4) but these are AUTHENTICATION flows -----
  // They mutate the acting user's own credential/session columns (password
  // hash, MFA secret, passkeys, phone, email verification, last-login), never
  // partner-wide configuration. Authority here is "is this you", not "may you
  // administer the partner".
  'routes/auth/cfAccessRedirectLogin.ts': 'writes the authenticating user\'s own session/login columns',
  'routes/auth/invite.ts': 'user invitation lifecycle; org/partner membership is gated by USERS_INVITE',
  'routes/auth/login.ts': 'writes last-login/lockout columns for the authenticating user',
  'routes/auth/mfa.ts': 'writes the acting user\'s own MFA enrolment',
  'routes/auth/passkeys.ts': 'writes the acting user\'s own passkey credentials',
  'routes/auth/password.ts': 'writes the acting user\'s own password hash',
  'routes/auth/ssoLinkCompletion.ts': 'SSO login completion (#4067): stamps the signing-in user\'s own last-login column',
  'routes/auth/phone.ts': 'writes the acting user\'s own phone factor',
  'routes/auth/verifyEmail.ts': 'writes the acting user\'s own email-verification state',
  'routes/system.ts': 'platform-admin/system bootstrap surface, gated on isPlatformAdmin',
  'routes/admin/abuse.ts': 'platform-admin abuse containment (suspend/flag), gated on isPlatformAdmin',

  // --- org provisioning: gated on the ORG axis, not the partner axis --------
  // Creating an organization under the partner is `organizations:write` plus
  // orgAccess handling tracked separately (security review §1.1 "adjacent
  // orgAccess gaps": orgs.ts:1345/1459, provisioning). It does not write a
  // partner-owned CONFIG row.
  'routes/agents/mtls.ts': 'agent enrolment touches organizations for cert/tenant bookkeeping, not partner config',
  'routes/partnerApi/provisioning.ts': 'service-principal org provisioning; authority comes from the principal\'s scopes',
  'services/aiToolsOrgs.ts': 'org CRUD tool; org-axis authority, no partner-owned row written',

  // --- integrations / connections owned by the partner but gated elsewhere ---
  'routes/accounting/index.ts': 'QBO/Xero connection lifecycle is gated by its own admin permission set',
  'routes/oauthInteraction.ts': 'records the end-user\'s own OAuth consent grant, not partner configuration',

  // --- known gaps, tracked; listed so the count cannot silently grow ---------
  'routes/alertTemplates/rules.ts': 'alert RULES are org-owned in practice; partner-wide rule ownership is not exposed by this route',
  'routes/softwareInstallMethods.ts': 'software_catalog rows here are catalog metadata, gated by the software permission set',
  'routes/softwareInventory.ts': 'read-oriented inventory surface; its policy writes delegate to softwarePolicies routes',

  // ==========================================================================
  // services/** (walk extended 2026-08-23 — the aiProvider/stripeConnect gate
  // gaps both lived in services the original routes-only walk never saw).
  // Class key: system-context / self-user / org-axis writes have no caller to
  // gate; "gated at <file>" entries are caller-facing services whose EVERY
  // mutating route carries the capability check — the gate lives one layer up,
  // so a NEW ungated route caller of these services will NOT be caught here.
  // ==========================================================================

  // --- system context / background / bootstrap ------------------------------
  'services/abuseSignals/persistence.ts': 'abuse-sweep worker persistence (jobs/abuseSignalsSweep); no tenant request writes partner config',
  'services/abuseSignals/scriptContent.ts': 'abuse-sweep script-host cache, populated only by the system abuse pipeline',
  'services/inboundEmail/inboundEmailService.ts': 'inbound-mail worker queue state (jobs/inboundEmailWorker); no tenant caller',
  'services/llm/llmConfigResolver.ts': 'runtime resolver; only write is the system-context version-CASed credential-error stamp',
  'services/partnerCreate.ts': 'new-partner bootstrap seeds first roles/user/org before any partner capability can exist',
  'services/platformAdminBootstrap.ts': 'startup-only platform-admin bootstrap (index.ts boot path); no tenant route calls it',
  'services/policyAlertBridge.ts': 'startup event subscriber creating derived alert artifacts in system context',
  'services/stripeConnectService.ts': 'Stripe-signed webhook records provider-side disconnect status; no tenant caller',
  'services/systemScriptLibrary.ts': 'startup-only system script library seed (index.ts boot path); writes is_system rows with org_id/partner_id NULL; no tenant route calls it',
  'services/tenantOffboarding.ts': 'offboarding/erasure lifecycle — the documented system-context exemption class',
  'services/unifi/unifiSyncService.ts': 'UniFi worker sync-run telemetry (jobs/unifiWorker); no tenant route calls the mutator',

  // --- self-user auth/profile columns (authority is "is this you") ----------
  'services/authLifecycle.ts': 'auth/session epoch columns for the acting user only',
  'services/avatarStorage.ts': 'acting user\'s own avatar columns via /me/avatar',
  'services/emailVerification.ts': 'verification-token lifecycle + the authenticating user\'s own columns',
  'services/officeAddin/officeAddinBindings.ts': 'per-user Entra bindings and revocation state, not partner config',
  'services/pendingEmail.ts': 'pending-email state and auth epochs for the acting user only',
  'services/recoveryCodeAuth.ts': 'atomically consumes one recovery code belonging to the authenticating user',

  // --- org-axis writes reached via org-gated routes -------------------------
  'services/contacts/compat.ts': 'updates one org\'s legacy billing-contact blob by org id',
  'services/invoiceService.ts': 'org billing settings + time-entry billing status, org-axis authority',
  'services/orgCurrencyService.ts': 'updates the selected organization\'s currency by org id',
  'services/orgImport/index.ts': 'org import creates org-axis rows; gated by organizations:write on the route',
  'services/quickSupportOrg.ts': 'quick-support provisioning creates an org-axis container',
  'services/softwareDownloadPolicy.ts': 'writes one org\'s encrypted settings by org id',
  'services/softwarePolicyService.ts': 'flagged table is append-only policy audit evidence, not config',
  'services/timeEntryService.ts': 'technician time/billing records, org/user-axis authority',
  // W06 (#3900). time_suggestion_decisions carries partner_id purely so the
  // Shape-3 RLS policy has an axis to check; the ROW is per-technician —
  // every write is `user_id = actor.userId` and every read/delete is scoped to
  // the caller's own decisions. Gating it on canManagePartnerWidePolicies would
  // mean only a partner admin could dismiss their own suggestion, which is the
  // opposite of the intent. Same class as timeEntryService.ts above.
  'services/timeSuggestionService.ts': 'per-technician suggestion decisions keyed on user_id (partner_id is only the RLS axis); never partner-wide config',

  // --- caller-facing, gated at the route layer (verify the gate when editing
  //     these services or adding ANY new route caller) -----------------------
  'services/aiAgents/agentService.ts': 'gated centrally in services/aiAgents/access.ts (assertAgentWriteAllowed), called before every write',
  // P2-5 (#4192). The promote executor writes the ORG axis ONLY, by
  // construction: the clone it may insert pins `partnerId: null` +
  // `orgId`, and the one UPDATE targets the id of a row it read under
  // `eq(aiAgents.orgId, orgId)` + `.for('update')`. A partner baseline row
  // is READ (locked, as the ceiling) and never written. There is also no
  // caller to gate: it runs only as the effect of an already-approved
  // Tier-3 four-eyes intent, whose own release re-checks the requester's
  // ai_agents:write RBAC.
  'services/aiAgents/supervisedKeyGrant.ts': 'grants one supervised key on the ORG row only (clone pins partner_id NULL; the update targets a row read by org_id); the partner baseline is read-locked as the ceiling, never written',
  // P2-5 (#4192), Task 16. The mirror of the promote executor above, and
  // ORG-axis by the same construction: the one UPDATE targets the id of a
  // row read under `eq(aiAgents.orgId, orgId)` + `.for('update')`, and the
  // partner baseline is read ONLY for its `kind` (pinned through the
  // organization's own partner) and never written — narrowing a partner
  // ceiling is a partner-level decision no automated signal from one org
  // may make. There is no caller to gate and deliberately no RBAC check:
  // auto-demote is ALWAYS ON, fired by the release worker's terminal CAS
  // and the fix-watch phase-2 verdict, and it only ever REMOVES authority.
  'services/aiAgents/supervisedKeyDemote.ts': 'revokes one supervised key from the ORG row only (the update targets a row read by org_id); the partner baseline is read for its kind and never written; always-on automatic path with no caller to gate, and it only ever removes authority',
  'services/aiAgents/managedAutomation.ts': 'seeds/syncs one agent\'s own managed automation; the owner axis is copied verbatim from the ai_agents row, never chosen by the caller, and every entry point (createAgent/updateAgent/disableAgent) has already passed assertAgentWriteAllowed — which throws PartnerWideWriteDeniedError for a partner-owned agent',
  'services/aiAgents/scheduleService.ts': 'gated centrally in services/aiAgents/access.ts (assertAgentWriteAllowed → PartnerWideWriteDeniedError) before every create/update/delete; partner rows additionally require a partner-wide triage agent under auth.partnerId (P2-2, #4189)',
  'services/automationRuntime.ts': 'manual trigger gated at routes/automations.ts; webhook path requires the provisioned automation secret',
  'services/builtinDeploymentPackages.ts': 'both callers behind requirePartnerManager (routes/huntress.ts, routes/sentinelOne.ts)',
  'services/partnerLlmConfig.ts': 'gated at routes/aiProvider.ts — canManagePartnerWidePolicies on every handler (#3889)',
  'services/partnerServicePrincipalKeys.ts': 'gated at routes/partnerServicePrincipals.ts capability check',
  'services/partnerStripe.ts': 'gated at routes/stripeConnect/index.ts — capability check on every handler (#3916)',
  'services/pax8SyncService.ts': 'every /pax8 route passes the global capability middleware in routes/pax8.ts',
  'services/policyEvaluationService.ts': 'partner-policy writes gated at routes/policyManagement/actions.ts; workers are system context',
  'services/tdSynnexDigitalBridge.ts': 'credential config/test gated at routes/catalog/distributors.ts partnerWideGate; search caches tokens',
  'services/tdSynnexEcExpress.ts': 'credential config/test gated at routes/catalog/distributors.ts partnerWideGate',
  'services/tdSynnexSftpSync.ts': 'credential config/test/sync gated at routes/catalog/distributors.ts partnerWideGate; worker is system context',
  'services/ticketConfigService.ts': 'gated by routes/ticketConfig.ts middleware; org/registration bootstrap paths are system-owned',
  'services/ticketMailbox/connectionService.ts': 'connect/retest/delete gated in routes/tickets/mailboxConnect.ts; polling is worker-owned',
  'services/ticketMailbox/consentSessionService.ts': 'consent start gated in routes/tickets/mailboxConnect.ts; callback consumes its signed session',
  'services/unifi/unifiConnectionService.ts': 'every /unifi route passes the global capability middleware in routes/unifi/index.ts',

  // --- catalog/accounting data on their own permission sets (precedent:
  //     routes/softwareInstallMethods.ts + routes/accounting/index.ts above) --
  'services/accounting/accountingConnectionService.ts': 'QBO/Xero connection lifecycle, gated by its own admin permission set (recorded exemption)',
  'services/accounting/accountingMappingService.ts': 'accounting_entity_mappings is integration external-ref data, not a partner-wide policy table; every write route in routes/accounting/index.ts passes requireScope(partner,system) + requireMfa() + requireMappingWrite (per-entity-type admin permission), and workers/erasure run under system context',
  'services/accounting/accountingInvoicePush.ts': 'same accounting_entity_mappings rows as accountingMappingService above, for the invoice entity type; the manual/bulk push routes pass requireScope(partner,system) + requireMfa() + INVOICES_WRITE, and the accounting-sync worker runs under system context',
  'services/catalogImageStorage.ts': 'catalog item images on the catalog permission set; partner-scope routes only',
  'services/catalogService.ts': 'catalog items/prices/bundles on the catalog permission set; partner-scope routes only',
  'services/pax8CatalogService.ts': 'pax8 catalog-item import on the catalog permission set; credentials live behind /pax8\'s global gate',

  // --- org lifecycle (org lifecycle wave 2, #4074) --------------------------
  'services/orgMerge.ts': 'org_merge_events writes run under system context from the merge engine; the HTTP surface is gated by routes/orgMerge.ts\'s requireScope(partner,system) + requireOrgWrite + MFA with per-org partner checks (authorizeMergePair, including auth.canAccessOrg(survivor.id) for \'selected\'-access partner members) — not a partner-wide policy table. Every write is already scoped to orgs the caller could act on individually; gating on canManagePartnerWidePolicies would incorrectly block partner members with plain org-write access from merging orgs they already manage.',
  'services/orgArchive.ts': 'archive/restore writes run under system context from the org-lifecycle service; the HTTP surface is gated by routes/orgArchive.ts\'s requireScope(partner,system) + requireOrgWrite + MFA, partner ownership of the target, AND the caller\'s own partner_users.org_ids selection (partnerMemberMayReachOrg, fail-closed for org_access=none) — organizations is not a partner-wide policy table. Every write is scoped to one org the caller may manage; gating on canManagePartnerWidePolicies would incorrectly block partner members with plain org-write access from archiving or restoring an org they already manage.',
};

/** Table export names whose rows can be partner-owned (org_id absent or nullable). */
function partnerAxisTableNames(): string[] {
  const names: string[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!value || typeof value !== 'object') continue;
    if (!is(value as never, PgTable)) continue;
    let columns: Record<string, { notNull: boolean }>;
    try {
      columns = getTableColumns(value as never) as unknown as Record<string, { notNull: boolean }>;
    } catch {
      continue;
    }
    const orgId = columns.orgId;
    const partnerId = columns.partnerId;
    if (partnerId && (!orgId || !orgId.notNull)) names.push(exportName);
  }
  return names.sort();
}

function collectSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith('.ts')) continue;
      if (full.endsWith('.test.ts') || full.endsWith('.d.ts')) continue;
      files.push(full);
    }
  };
  walk(join(API_SRC, 'routes'));
  walk(join(API_SRC, 'services'));
  return files.sort();
}

/** Tables this file passes to `.insert()` / `.update()` / `.delete()`. */
function mutatedTables(source: string, tableNames: string[]): string[] {
  return tableNames.filter((table) =>
    new RegExp(`\\.(insert|update|delete)\\(\\s*${table}\\s*[,)]`).test(source)
  );
}

describe('partner-wide write coverage (security review 2026-08-16 §1.1)', () => {
  const tableNames = partnerAxisTableNames();

  it('derives a non-trivial partner-axis table set from the live schema', () => {
    // Guards the guard: if the derivation silently returns [] (a schema import
    // shape change, a Drizzle upgrade), every assertion below passes vacuously.
    expect(tableNames.length).toBeGreaterThan(30);
    expect(tableNames).toContain('customFieldDefinitions');
    expect(tableNames).toContain('partnerServicePrincipals');
    expect(tableNames).toContain('patchPolicies');
    expect(tableNames).toContain('authenticatorPolicies');
    expect(tableNames).toContain('alertTemplates');
    expect(tableNames).toContain('clientAiPromptTemplates');
  });

  // 30s, not the 5s default. Both cases below synchronously read every .ts
  // under src/routes and src/services (~1,100 files — see collectSourceFiles
  // above; the scan is deliberately NOT the whole of src). That is ~2s when
  // this file runs alone, but under a full-suite run it has been observed at
  // 13.6s — over the default, so the job fails on a TIMEOUT that says nothing
  // about partner-wide write safety. #3928 (80b498ece) grew the scan ~2.5x by
  // extending it from routes/** to services/**, which moved this from
  // comfortable to borderline.
  //
  // The timeout is the only thing raised here: the scan and its assertions are
  // unchanged, so a real violation still fails exactly as before.
  it('every caller-facing partner-axis write site consults the capability helper', () => {
    const violations: string[] = [];

    for (const file of collectSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      const tables = mutatedTables(source, tableNames);
      if (tables.length === 0) continue;

      const rel = relative(API_SRC, file);
      if (rel in ALLOWED_WITHOUT_CAPABILITY_CHECK) continue;
      if (source.includes(CAPABILITY_FN)) continue;

      violations.push(`${rel} mutates ${tables.join(', ')} without calling ${CAPABILITY_FN}()`);
    }

    expect(
      violations,
      `Partner-wide write sites missing the ${CAPABILITY_FN}() gate.\n` +
        'Add the gate (403 + PARTNER_WIDE_WRITE_DENIED_MESSAGE), or, if the write genuinely ' +
        'cannot touch a partner-owned row, add the file to ALLOWED_WITHOUT_CAPABILITY_CHECK ' +
        'with a reason.\n' +
        violations.join('\n')
    ).toEqual([]);
  }, 30_000);

  // Same full-tree scan, same reasoning as above.
  it('the allowlist has no stale entries', () => {
    // A file that stopped mutating partner-axis tables (or moved) must leave the
    // allowlist, or the exemption silently outlives the code it excused.
    const stillMutating = new Set(
      collectSourceFiles()
        .filter((file) => mutatedTables(readFileSync(file, 'utf8'), tableNames).length > 0)
        .map((file) => relative(API_SRC, file))
    );

    const stale = Object.keys(ALLOWED_WITHOUT_CAPABILITY_CHECK).filter((rel) => !stillMutating.has(rel));
    expect(stale, `Remove these from ALLOWED_WITHOUT_CAPABILITY_CHECK: ${stale.join(', ')}`).toEqual([]);
  }, 30_000);

  it('every allowlist entry documents why it is exempt', () => {
    const undocumented = Object.entries(ALLOWED_WITHOUT_CAPABILITY_CHECK)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([rel]) => rel);
    expect(undocumented).toEqual([]);
  });

  it('the six sites from the 2026-08-16 review carry the gate', () => {
    // Named explicitly so a regression on any ONE of them is a clearly-labelled
    // failure rather than an anonymous line in the sweep above.
    const fixed = [
      'routes/customFields.ts',
      'routes/authenticator.ts',
      'routes/updateRings.ts',
      'services/aiToolsPolicyPrereqs.ts',
      'routes/clientAi/adminTemplates.ts',
      'routes/alertTemplates/templates.ts',
      'routes/partnerServicePrincipals.ts',
    ];

    for (const rel of fixed) {
      const source = readFileSync(join(API_SRC, rel), 'utf8');
      expect(source.includes(CAPABILITY_FN), `${rel} lost its ${CAPABILITY_FN}() gate`).toBe(true);
    }
  });
});
