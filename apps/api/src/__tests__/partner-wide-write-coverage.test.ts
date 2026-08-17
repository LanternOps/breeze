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
 *   A file under `src/routes/**` or `src/services/aiTools*.ts` that mutates a
 *   PARTNER-AXIS table must mention `canManagePartnerWidePolicies`.
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
  for (const entry of readdirSync(join(API_SRC, 'services'))) {
    if (/^aiTools.*\.ts$/.test(entry) && !entry.endsWith('.test.ts')) {
      files.push(join(API_SRC, 'services', entry));
    }
  }
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
  });

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
  });

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
