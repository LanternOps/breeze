/**
 * CONTRACT TEST — every caller-facing write to an org-wide GOVERNANCE object
 * must consult `canMutateOrgWideGovernance` (contract-site-ceiling-gate).
 *
 * Owner decision (2026-09-10): a caller with a defined site ceiling
 * (`allowedSiteIds` set, including `[]`) may not create/update/delete/enable/
 * test an org-wide governance object: webhooks, notification channels,
 * software policies, peripheral policies, configuration-policy parents +
 * feature links, PAM org config + signer groups, and backup configs +
 * profiles. There is no per-site ownership model for these objects.
 *
 * Mirrors `partner-wide-write-coverage.test.ts` exactly, on the OTHER,
 * orthogonal axis: that file asks "may this caller act at partner breadth";
 * this one asks "does this caller's site ceiling block them from org-wide
 * objects at all". Both gates can apply to the same route.
 *
 * Per §7C of the contract, the seven GOVERNANCE TABLES are hand-specified
 * (they are a fixed, named list of objects with no per-site ownership model —
 * not something derivable from a schema shape the way the partner-axis test
 * derives its table set), but the FILE list that touches them is walked
 * mechanically, never hand-listed. A file under `src/routes/**` or
 * `src/services/**` that mutates one of these tables must mention
 * `canMutateOrgWideGovernance` or carry a documented allowlist exemption.
 *
 * The check is textual (does the file mention the helper?), not semantic — it
 * cannot prove the gate is placed correctly or that it fires before the
 * write, only that the author was made to think about it. Per-route
 * `*.siteScope.test.ts` files assert the 403 actually fires before any DB
 * access. A grep-level guard that fires on every real gap is worth far more
 * than a clever one that ships.
 *
 * Adding a file here: FIRST convince yourself the write genuinely cannot be
 * reached by a site-restricted caller (e.g. it always reloads by id from a
 * queued job in system context, with no caller-supplied identity). Then add
 * it to ALLOWED_WITHOUT_CEILING_CHECK with a reason. An entry with no reason
 * is a bug you have not found yet.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';

const CAPABILITY_FN = 'canMutateOrgWideGovernance';
const API_SRC = resolve(__dirname, '..');

/**
 * The seven org-wide governance tables named in the contract. Hand-specified
 * on purpose (§7C) — this is a fixed policy decision (which object CLASSES
 * have no per-site ownership model), not a structural property of the schema
 * the way the partner-axis table set is.
 */
const GOVERNANCE_TABLE_NAMES = [
  'webhooks',
  'notificationChannels',
  'softwarePolicies',
  'peripheralPolicies',
  'configurationPolicies',
  'configPolicyFeatureLinks',
  'pamOrgConfig',
  'pamSignerGroups',
  'backupConfigs',
  'backupProfiles',
] as const;

/**
 * Files that mutate a governance table but legitimately do not need the
 * site-ceiling gate. Every entry carries the reason it is exempt.
 */
const ALLOWED_WITHOUT_CEILING_CHECK: Record<string, string> = {
  // configurationPolicy.ts is the ONLY place that literally calls
  // .insert/.update/.delete(configurationPolicies | configPolicyFeatureLinks)
  // — routes/configurationPolicies/{crud,featureLinks}.ts and
  // services/aiToolsConfigPolicy.ts delegate to it and are gated themselves
  // (they each call canMutateOrgWideGovernance before invoking these
  // functions). Verify both callers still gate before editing this file.
  'services/configurationPolicy.ts':
    'mutations here are reached only through routes/configurationPolicies/{crud,featureLinks}.ts and services/aiToolsConfigPolicy.ts, which each call canMutateOrgWideGovernance before invoking these functions — verify both callers still gate when editing this file',

  // Worker-side delivery-outcome bookkeeping (successCount/failureCount/
  // lastDeliveryAt only — never enabled/url/secret/events) runs inside
  // runWithSystemDbAccess after the webhook delivery WORKER finishes an
  // attempt. There is no caller-scoped auth object on this path at all — it
  // is invoked from workers/webhookDelivery.ts's own result handling, never
  // from an HTTP route or AI tool.
  'services/webhookDeliveryRecord.ts':
    'updates only successCount/failureCount/lastDeliveryAt after a delivery attempt, invoked from the delivery worker in system context (runWithSystemDbAccess) — no caller-scoped auth object reaches this path',

  // configureDefaults creates a default notification channel as part of
  // MCP-invite PARTNER BOOTSTRAP — the caller is a freshly-minted partner
  // API key with no org-scoped `allowedSiteIds` at all (site ceilings only
  // ever apply to organization-scope callers), and the tool always targets
  // the org being bootstrapped, never one chosen by a site-restricted
  // caller.
  'modules/mcpInvites/tools/configureDefaults.ts':
    'creates the default admin-email notification channel during MCP-invite partner bootstrap — the caller is a partner-bootstrap key, not a site-restricted org-scope caller, and the target org is fixed by the bootstrap context, not caller-chosen',
};

/**
 * Local identifiers a file's mutations might use for a given table: the
 * table's own export name, plus any `<table> as <alias>` rename found in the
 * file's own `import { ... } from '.../db/schema...'` — e.g.
 * `routes/webhooks.ts` imports `webhooks as webhooksTable` and mutates via
 * `webhooksTable`, never the bare export name.
 */
function localIdentifiers(source: string, table: string): string[] {
  const identifiers = new Set([table]);
  const aliasRe = new RegExp(`\\b${table}\\s+as\\s+(\\w+)`, 'g');
  for (const match of source.matchAll(aliasRe)) {
    identifiers.add(match[1]!);
  }
  return [...identifiers];
}

/**
 * Tables this file passes to `.insert()` / `.update()` / `.delete()`.
 *
 * Matches both the bare identifier (`.update(webhooksTable)`) and a
 * namespace-qualified reference (`.insert(schema.webhooks)`) — the latter
 * has no current call site in this repo, but the check should not go blind
 * to it the moment one appears.
 *
 * Out of reach by construction: a raw `sql`` UPDATE (e.g.
 * `services/orgMergeCustomExecutors.ts`'s system-only `backup_configs`
 * repoint during an org merge) never matches `.insert/.update/.delete(`, so
 * this guard cannot see it. That's an accepted gap, not an oversight — org
 * merge runs in system context with no caller-scoped auth to gate on.
 */
function mutatedTables(source: string, tableNames: readonly string[]): string[] {
  return tableNames.filter((table) =>
    localIdentifiers(source, table).some((id) =>
      new RegExp(`\\.(insert|update|delete)\\(\\s*(?:\\w+\\.)?${id}\\s*[,)]`).test(source)
    )
  );
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
  walk(join(API_SRC, 'jobs'));
  walk(join(API_SRC, 'workers'));
  // Non-core write surfaces that can still reach a governance table: modules
  // are self-contained feature packages (e.g. MCP-invite partner-bootstrap
  // tools) and extensions are the ee/ built-in extension host. Both are
  // optional dirs — skip silently if absent rather than requiring every
  // checkout to have them.
  for (const dir of ['modules', 'extensions']) {
    const full = join(API_SRC, dir);
    try {
      if (statSync(full).isDirectory()) walk(full);
    } catch {
      // dir doesn't exist — nothing to walk.
    }
  }
  return files.sort();
}

describe('site-ceiling write coverage (contract-site-ceiling-gate)', () => {
  it('every caller-facing governance-table write site consults the capability helper', () => {
    const violations: string[] = [];

    for (const file of collectSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      const tables = mutatedTables(source, GOVERNANCE_TABLE_NAMES);
      if (tables.length === 0) continue;

      const rel = relative(API_SRC, file);
      if (rel in ALLOWED_WITHOUT_CEILING_CHECK) continue;
      if (source.includes(CAPABILITY_FN)) continue;

      violations.push(`${rel} mutates ${tables.join(', ')} without calling ${CAPABILITY_FN}()`);
    }

    expect(
      violations,
      `Site-ceiling write sites missing the ${CAPABILITY_FN}() gate.\n` +
        'Add the gate (403 + SITE_CEILING_WRITE_DENIED_MESSAGE), or, if the write genuinely ' +
        'cannot be reached by a site-restricted caller (e.g. a worker reloading by id in ' +
        'system context), add the file to ALLOWED_WITHOUT_CEILING_CHECK with a reason.\n' +
        violations.join('\n')
    ).toEqual([]);
  }, 30_000);

  it('the allowlist has no stale entries', () => {
    const stillMutating = new Set(
      collectSourceFiles()
        .filter((file) => mutatedTables(readFileSync(file, 'utf8'), GOVERNANCE_TABLE_NAMES).length > 0)
        .map((file) => relative(API_SRC, file))
    );

    const stale = Object.keys(ALLOWED_WITHOUT_CEILING_CHECK).filter((rel) => !stillMutating.has(rel));
    expect(stale, `Remove these from ALLOWED_WITHOUT_CEILING_CHECK: ${stale.join(', ')}`).toEqual([]);
  }, 30_000);

  it('every allowlist entry documents why it is exempt', () => {
    const undocumented = Object.entries(ALLOWED_WITHOUT_CEILING_CHECK)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([rel]) => rel);
    expect(undocumented).toEqual([]);
  });

  it('the ten call sites fixed by this contract carry the gate', () => {
    const fixed = [
      'routes/webhooks.ts',
      'routes/alerts/channels.ts',
      'routes/softwarePolicies.ts',
      'routes/softwareInventory.ts',
      'routes/peripheralControl.ts',
      'routes/configurationPolicies/crud.ts',
      'routes/configurationPolicies/featureLinks.ts',
      'routes/pam.ts',
      'routes/backup/configs.ts',
      'routes/backup/profiles.ts',
      'services/aiToolsPeripherals.ts',
      'services/aiToolsConfigPolicy.ts',
      'services/aiToolsPolicyPrereqs.ts',
      'services/aiToolsCompliance.ts',
      'services/aiToolsAlerts.ts',
      'services/aiToolsFleet.ts',
      'services/aiToolsIntegrations.ts',
    ];

    for (const rel of fixed) {
      const source = readFileSync(join(API_SRC, rel), 'utf8');
      expect(source.includes(CAPABILITY_FN), `${rel} lost its ${CAPABILITY_FN}() gate`).toBe(true);
    }
  });
});

/**
 * Site-ceiling gate contract §3/§7E — in-flight job protection. Three of the
 * ten governance tables (webhooks, softwarePolicies, backupConfigs) carry an
 * `approval_generation` column that every caller-facing write must bump, so
 * a job already queued against the OLD generation can tell it was
 * superseded (see `services/approvalGeneration.ts`).
 *
 * This is the SAME kind of mechanical, textual check as the capability-gate
 * guard above, on the orthogonal §3 axis: does the FILE that writes one of
 * these three tables also reference `approvalGeneration`? It cannot prove
 * every individual `.update().set()` call site in that file bumps it (a
 * file with multiple update sites, only some of which bump, still passes) —
 * only that the author was made to think about it. Real coverage comes from
 * the per-route/service tests that assert on the actual `.set()` payload
 * (e.g. `routes/webhooks.test.ts`, `services/aiToolsCompliance
 * .auditAndArming.test.ts`).
 */
describe('approval_generation bump coverage (contract-site-ceiling-gate §3/§7E)', () => {
  const GENERATION_TABLE_NAMES = ['webhooks', 'softwarePolicies', 'backupConfigs'] as const;
  const GENERATION_TOKEN = 'approvalGeneration';

  const ALLOWED_WITHOUT_GENERATION_BUMP: Record<string, string> = {
    // Worker-side delivery-outcome bookkeeping — never a governing edit
    // (enabled/url/secret/events) a queued job needs to detect. Same file,
    // same reasoning as its entry in ALLOWED_WITHOUT_CEILING_CHECK above.
    'services/webhookDeliveryRecord.ts':
      'updates only successCount/failureCount/lastDeliveryAt after a delivery attempt — never a governing edit a queued job needs to detect',
  };

  it('every file that writes a generation-tracked table also references approvalGeneration', () => {
    const violations: string[] = [];

    for (const file of collectSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      const tables = mutatedTables(source, GENERATION_TABLE_NAMES);
      if (tables.length === 0) continue;

      const rel = relative(API_SRC, file);
      if (rel in ALLOWED_WITHOUT_GENERATION_BUMP) continue;
      if (source.includes(GENERATION_TOKEN)) continue;

      violations.push(`${rel} writes ${tables.join(', ')} without referencing ${GENERATION_TOKEN}`);
    }

    expect(
      violations,
      `Write sites missing an ${GENERATION_TOKEN} bump (contract §3/§7E).\n` +
        'Bump it via services/approvalGeneration.ts\'s bumpApprovalGeneration(), or, if the write ' +
        'genuinely never needs to be detected by a queued job, add the file to ' +
        'ALLOWED_WITHOUT_GENERATION_BUMP with a reason.\n' +
        violations.join('\n')
    ).toEqual([]);
  }, 30_000);

  it('the generation-bump allowlist has no stale entries', () => {
    const stillMutating = new Set(
      collectSourceFiles()
        .filter((file) => mutatedTables(readFileSync(file, 'utf8'), GENERATION_TABLE_NAMES).length > 0)
        .map((file) => relative(API_SRC, file))
    );

    const stale = Object.keys(ALLOWED_WITHOUT_GENERATION_BUMP).filter((rel) => !stillMutating.has(rel));
    expect(stale, `Remove these from ALLOWED_WITHOUT_GENERATION_BUMP: ${stale.join(', ')}`).toEqual([]);
  }, 30_000);
});
