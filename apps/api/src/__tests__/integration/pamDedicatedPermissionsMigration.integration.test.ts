/**
 * Live-DB replay test for 2026-10-15-150200-pam-dedicated-permissions.sql
 * (fix/pam-dedicated-permissions). Exercises the migration file directly
 * against a real Postgres instance — not the seeded state a fresh
 * `autoMigrate` run leaves behind — covering the four properties the PR
 * description promises:
 *
 *   1. pam:approve / pam:manage_policy permission rows exist exactly once.
 *   2. Re-running the migration is a no-op (no duplicate rows/grants).
 *   3. The grant reaches BOTH the global system-template Org Admin row
 *      (partner_id IS NULL) AND a per-partner is_system Org Admin clone
 *      (§6A) — but never a custom role merely named "Org Admin"
 *      (is_system = false).
 *   4. A pre-existing auto_approve pam_rules row is quarantined regardless
 *      of `enabled` (PR review fix — a disabled legacy auto_approve rule
 *      must also require re-approval before it can ever start matching
 *      again): verdict -> require_approval, suspended_verdict preserves the
 *      original verdict, `enabled` itself is left untouched (§6B — NEVER
 *      set enabled=false, since pamRuleEngine.ts skips disabled rules and
 *      falls through), and re-running is idempotent (no double-quarantine).
 */
import './setup';
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-10-15-150200-pam-dedicated-permissions.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');

// A dedicated superuser client (the role autoMigrate runs as) with onnotice
// wired so the migration's RAISE WARNING row counts can be asserted, mirroring
// __tests__/integration/documentLocaleBackfill.integration.test.ts.
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', {
  max: 1,
  onnotice: (n) => { notices.push(String(n.message)); },
});
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

async function replay(): Promise<string[]> {
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  return [...notices];
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function makePartner(name: string) {
  const [row] = await adminSql`
    insert into partners (name, slug, type, plan, status, currency_code)
    values (${name}, ${uniqueSlug('pam-mig')}, 'msp', 'free', 'active', 'USD')
    returning id
  `;
  return row!.id as string;
}

async function makeOrg(partnerId: string, name: string) {
  const [row] = await adminSql`
    insert into organizations (partner_id, name, slug, currency_code)
    values (${partnerId}, ${name}, ${uniqueSlug('pam-mig-org')}, 'USD')
    returning id
  `;
  return row!.id as string;
}

describe.skipIf(!RUN)('migration: 2026-10-15-150200-pam-dedicated-permissions', () => {
  it('permission rows exist exactly once for pam:approve and pam:manage_policy', async () => {
    await replay();
    const approve = await adminSql`select id from permissions where resource = 'pam' and action = 'approve'`;
    const managePolicy = await adminSql`select id from permissions where resource = 'pam' and action = 'manage_policy'`;
    expect(approve).toHaveLength(1);
    expect(managePolicy).toHaveLength(1);
  });

  it('re-running the migration is a no-op: no duplicate permission rows or grants', async () => {
    await replay(); // ensure baseline seeded
    const countPam = () => adminSql`select count(*)::int as n from permissions where resource = 'pam'`;
    const countGrants = () => adminSql`
      select count(*)::int as n from role_permissions rp
      join permissions p on p.id = rp.permission_id
      where p.resource = 'pam'
    `;

    const beforePerm = (await countPam())[0]!.n;
    const beforeGrant = (await countGrants())[0]!.n;

    const msgs = await replay();

    const afterPerm = (await countPam())[0]!.n;
    const afterGrant = (await countGrants())[0]!.n;

    expect(afterPerm).toBe(beforePerm);
    expect(afterGrant).toBe(beforeGrant);
    // A clean re-run seeds nothing new and grants nothing new.
    expect(msgs.some((m) => m.startsWith('seeded pam:'))).toBe(false);
    expect(msgs.some((m) => m.startsWith('granted pam:'))).toBe(false);
  });

  it('grants reach BOTH the global system-template Org Admin AND a per-partner is_system clone, never a forged custom role sharing the name', async () => {
    await replay(); // ensure the permission rows exist

    const partnerId = await makePartner('PAM Migration Grant Test');

    // The global system-template row (partner_id IS NULL, org_id IS NULL) is
    // normally created once by seed.ts on a fresh install; setup.ts's
    // per-test cleanupDatabase() TRUNCATEs `roles` between tests, so this
    // test creates it explicitly rather than relying on incidental state —
    // matching seed.ts's own shape for the row exactly.
    const [globalTemplateSeed] = await adminSql`
      insert into roles (scope, name, is_system, force_mfa)
      values ('organization', 'Org Admin', true, false)
      returning id
    `;

    // §6A production shape: a per-partner is_system clone alongside the
    // global template.
    const [clone] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'organization', 'Org Admin', true, false)
      returning id
    `;
    // Anti-forgery control: a custom role sharing the exact name but
    // is_system = false (routes/roles.ts always creates custom roles this
    // way) must NEVER be swept in by a name-only match.
    const [forged] = await adminSql`
      insert into roles (partner_id, scope, name, is_system, force_mfa)
      values (${partnerId}, 'organization', 'Org Admin', false, false)
      returning id
    `;

    await replay();

    const [approvePerm] = await adminSql`select id from permissions where resource = 'pam' and action = 'approve'`;
    const [policyPerm] = await adminSql`select id from permissions where resource = 'pam' and action = 'manage_policy'`;
    for (const roleId of [clone!.id, globalTemplateSeed!.id]) {
      const grants = await adminSql`select permission_id from role_permissions where role_id = ${roleId}`;
      const grantedIds = grants.map((g) => g.permission_id as string);
      expect(grantedIds).toContain(approvePerm!.id);
      expect(grantedIds).toContain(policyPerm!.id);
    }

    const forgedGrants = await adminSql`select permission_id from role_permissions where role_id = ${forged!.id}`;
    const forgedGrantedIds = forgedGrants.map((g) => g.permission_id as string);
    expect(forgedGrantedIds).not.toContain(approvePerm!.id);
    expect(forgedGrantedIds).not.toContain(policyPerm!.id);
  });

  it('quarantines a pre-existing enabled auto_approve rule (verdict -> require_approval, suspended_verdict set, stays enabled) and is idempotent on re-run', async () => {
    await replay(); // baseline

    const partnerId = await makePartner('PAM Quarantine Test');
    const orgId = await makeOrg(partnerId, 'Quarantine Org');

    const [rule] = await adminSql`
      insert into pam_rules (org_id, name, verdict, match_signer)
      values (${orgId}, 'legacy auto-approve installer', 'auto_approve', 'Acme Corp')
      returning id
    `;

    const msgs = await replay();

    const [after] = await adminSql`
      select verdict, suspended_verdict, enabled from pam_rules where id = ${rule!.id}
    `;
    expect(after!.verdict).toBe('require_approval');
    expect(after!.suspended_verdict).toBe('auto_approve');
    // §6B: the rule keeps matching — NEVER set enabled=false, which
    // pamRuleEngine.ts skips entirely and falls through to a lower-priority
    // rule or the org default (silently turning auto-approve into auto-deny).
    expect(after!.enabled).toBe(true);
    expect(msgs.some((m) => /^quarantined \d+ auto_approve pam rules/.test(m) && !m.startsWith('quarantined 0 '))).toBe(true);

    // Re-run: the row no longer matches `verdict = 'auto_approve'`, so it is
    // left exactly as re-approval would find it — no double-quarantine.
    await replay();
    const [after2] = await adminSql`
      select verdict, suspended_verdict from pam_rules where id = ${rule!.id}
    `;
    expect(after2).toEqual({ verdict: 'require_approval', suspended_verdict: 'auto_approve' });
  });

  // PR review fix: the original cut left `AND enabled` on the quarantine
  // WHERE clause, so a disabled legacy auto_approve rule stayed
  // verdict='auto_approve' with no suspended_verdict — re-enabling it later
  // (a plain `enabled: true` PATCH) would let it start auto-approving again
  // with NO re-approval ceremony, silently bypassing the whole §6B upgrade
  // path. Quarantine must apply on `verdict = 'auto_approve'` alone,
  // independent of `enabled`, matching the docs/upgrade note.
  it('ALSO quarantines a disabled auto_approve rule (enabled is left untouched); leaves an enabled non-auto_approve rule alone', async () => {
    await replay();

    const partnerId = await makePartner('PAM Quarantine Negative Test');
    const orgId = await makeOrg(partnerId, 'Quarantine Negative Org');

    const [disabledRule] = await adminSql`
      insert into pam_rules (org_id, name, verdict, enabled, match_signer)
      values (${orgId}, 'already disabled', 'auto_approve', false, 'Acme Corp')
      returning id
    `;
    const [requireApprovalRule] = await adminSql`
      insert into pam_rules (org_id, name, verdict, match_signer)
      values (${orgId}, 'ordinary require_approval', 'require_approval', 'Acme Corp')
      returning id
    `;

    await replay();

    const [afterDisabled] = await adminSql`
      select verdict, suspended_verdict, enabled from pam_rules where id = ${disabledRule!.id}
    `;
    // Quarantined exactly like an enabled rule would be — `enabled` itself
    // is never touched by this migration, in either direction.
    expect(afterDisabled).toEqual({ verdict: 'require_approval', suspended_verdict: 'auto_approve', enabled: false });

    const [afterRequireApproval] = await adminSql`
      select verdict, suspended_verdict from pam_rules where id = ${requireApprovalRule!.id}
    `;
    expect(afterRequireApproval).toEqual({ verdict: 'require_approval', suspended_verdict: null });
  });
});
