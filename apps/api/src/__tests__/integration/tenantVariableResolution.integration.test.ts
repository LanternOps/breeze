/**
 * Tenant variable resolution (#3409 PR 2) — real-Postgres coverage for
 * `loadTenantVariableScope` / `resolveForOrg` / `substituteTenantVariables`.
 *
 * `services/tenantVariableResolution.test.ts` proves the WHERE-clause shape
 * against a mocked db; this suite proves the six properties that only mean
 * anything against a real RLS-enforcing database:
 *   1. org-owned value shadows the partner-wide one with the same key
 *   2. an org inherits its partner's partner-wide value
 *   3. an org NEVER sees another partner's partner-wide value
 *   4. a two-org snapshot resolves each org independently in one call
 *   5. resolution still returns partner-wide rows when called from INSIDE an
 *      org-scoped withDbAccessContext — the regression proving the
 *      runOutsideDbContext + withSystemDbAccessContext escape is present.
 *      Comment out that escape in tenantVariableResolution.ts and THIS test
 *      is the one that goes red (an org token's JWT lacks partnerId, so a
 *      nested withSystemDbAccessContext that fails to elevate would see zero
 *      partner-wide rows for the org under test).
 *   6. a secret variable is loaded into the snapshot but substitution reports
 *      it via secretsReferenced and never places its value in content.
 *
 * Modeled on tenantVariablesPartnerRls.integration.test.ts (same
 * createPartner/createOrganization/withDbAccessContext helpers). Fixture rows
 * are inserted through services/tenantVariables.ts's own
 * encryptTenantVariableValue so the resolver's decryptTenantVariableValue call
 * actually round-trips them — a literal ciphertext placeholder (as the RLS
 * suite uses, since it never decrypts) would make every resolved value
 * silently fail to decrypt and vanish from the snapshot.
 */
import './setup';
import { randomUUID } from 'crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { tenantVariables, type TenantVariableRow } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { encryptTenantVariableValue } from '../../services/tenantVariables';
import {
  describeVariableFailure,
  loadTenantVariableScope,
  resolveForOrg,
  substituteTenantVariables
} from '../../services/tenantVariableResolution';

const created: string[] = [];

function systemContext(): DbAccessContext {
  return { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
}

/**
 * An org-scoped session whose JWT carries no partnerId on the accessible-ids
 * axis — accessiblePartnerIds stays empty, mirroring production exactly (see
 * tenantVariablesPartnerRls.integration.test.ts's orgContext). This is the
 * context property 5 dispatches resolution from: if the system-context escape
 * in loadTenantVariableScope were missing, this ambient context (which cannot
 * see partner-wide rows via RLS) would silently constrain the "system" query
 * too, and the partner-wide fixture would disappear from the snapshot.
 */
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId
  };
}

interface FixtureOptions {
  orgId?: string | null;
  partnerId?: string | null;
  key?: string;
  isSecret?: boolean;
}

/** Insert one tenant_variables row with a real, decryptable ciphertext. */
async function insertVariable(plaintext: string, options: FixtureOptions): Promise<TenantVariableRow> {
  const id = randomUUID();
  const [row] = await withDbAccessContext(systemContext(), () =>
    db
      .insert(tenantVariables)
      .values({
        id,
        orgId: options.orgId ?? null,
        partnerId: options.partnerId ?? null,
        key: options.key ?? 'repo_url',
        value: encryptTenantVariableValue(id, plaintext),
        isSecret: options.isSecret ?? false
      })
      .returning()
  );
  if (!row) throw new Error('insert returned no row');
  created.push(row.id);
  return row;
}

afterEach(async () => {
  if (created.length === 0) return;
  await withDbAccessContext(systemContext(), async () => {
    for (const id of created) {
      await db.delete(tenantVariables).where(eq(tenantVariables.id, id));
    }
  });
  created.length = 0;
});

describe('tenant variable resolution (integration)', () => {
  it('1. org-owned value shadows the partner-wide one with the same key', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await insertVariable('partner-value', { partnerId: partner.id, key: 'k' });
    await insertVariable('org-value', { orgId: org.id, key: 'k' });

    const scope = await loadTenantVariableScope([org.id]);
    const resolved = resolveForOrg(scope, org.id);
    expect(resolved.get('k')?.value).toBe('org-value');
  });

  it('2. an org inherits its partner\'s partner-wide value', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await insertVariable('inherited-value', { partnerId: partner.id, key: 'inherited_key' });

    const scope = await loadTenantVariableScope([org.id]);
    const resolved = resolveForOrg(scope, org.id);
    expect(resolved.get('inherited_key')?.value).toBe('inherited-value');
  });

  it('3. an org NEVER sees another partner\'s partner-wide value', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    await insertVariable('partner-b-secret-value', { partnerId: partnerB.id, key: 'shared_key' });
    await insertVariable('partner-a-value', { partnerId: partnerA.id, key: 'shared_key' });

    const scope = await loadTenantVariableScope([orgA.id]);
    const resolved = resolveForOrg(scope, orgA.id);
    expect(resolved.get('shared_key')?.value).toBe('partner-a-value');
    expect([...resolved.values()].some((v) => v.value === 'partner-b-secret-value')).toBe(false);
  });

  it('4. a two-org snapshot resolves each org independently in one call', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    await insertVariable('shared-partner-value', { partnerId: partner.id, key: 'shared' });
    await insertVariable('org-a-only-value', { orgId: orgA.id, key: 'only_a' });
    await insertVariable('org-b-only-value', { orgId: orgB.id, key: 'only_b' });

    const scope = await loadTenantVariableScope([orgA.id, orgB.id]);

    const resolvedA = resolveForOrg(scope, orgA.id);
    expect(resolvedA.get('shared')?.value).toBe('shared-partner-value');
    expect(resolvedA.get('only_a')?.value).toBe('org-a-only-value');
    expect(resolvedA.has('only_b')).toBe(false);

    const resolvedB = resolveForOrg(scope, orgB.id);
    expect(resolvedB.get('shared')?.value).toBe('shared-partner-value');
    expect(resolvedB.get('only_b')?.value).toBe('org-b-only-value');
    expect(resolvedB.has('only_a')).toBe(false);
  });

  it('5. resolution called from INSIDE an org-scoped withDbAccessContext still returns partner-wide rows', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await insertVariable('inherited-under-org-context', { partnerId: partner.id, key: 'inherited_under_org' });

    // The critical difference from every other test in this file: the call to
    // loadTenantVariableScope happens WHILE an org-scoped RLS context is
    // already open on this async context — exactly how the route path calls
    // it from inside a held request transaction. If the
    // runOutsideDbContext(() => withSystemDbAccessContext(...)) escape in
    // loadTenantVariableScope were removed, withSystemDbAccessContext would
    // be a no-op nested inside this org context (see db/index.ts:
    // withDbAccessContext returns immediately when a context is already on
    // the stack), the ambient org GUCs would stay in force, and — because
    // this org context's accessiblePartnerIds is deliberately empty, mirroring
    // an org JWT with no partnerId — the partner-wide row would be invisible
    // to RLS and vanish from the snapshot.
    const resolved = await withDbAccessContext(orgContext(org.id, partner.id), async () => {
      const scope = await loadTenantVariableScope([org.id]);
      return resolveForOrg(scope, org.id);
    });

    expect(resolved.get('inherited_under_org')?.value).toBe('inherited-under-org-context');
  });

  it('6. a secret variable is loaded but reported via secretsReferenced, never substituted', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await insertVariable('super-secret-value', { orgId: org.id, key: 's1_token', isSecret: true });

    const scope = await loadTenantVariableScope([org.id]);
    const resolved = resolveForOrg(scope, org.id);
    expect(resolved.get('s1_token')).toMatchObject({ isSecret: true, value: 'super-secret-value' });

    const outcome = substituteTenantVariables('curl -H "Authorization: {{var.s1_token}}"', resolved);
    expect(outcome.content).not.toContain('super-secret-value');
    expect(outcome.content).toContain('{{var.s1_token}}');
    expect(outcome.secretsReferenced).toEqual(['s1_token']);
    expect(outcome.unresolved).toEqual([]);

    const failure = describeVariableFailure(outcome);
    expect(failure).toMatch(/s1_token/);
    expect(failure).not.toContain('super-secret-value');
  });
});
