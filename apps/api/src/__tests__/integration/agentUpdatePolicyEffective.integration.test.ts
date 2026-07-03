/**
 * Integration test: getOrgAgentUpdatePolicy effective (partner→org) resolution
 * against real Postgres + RLS (issue #2123).
 *
 * The unit tests (helpers.agentUpdatePolicy.test.ts) prove the MERGE LOGIC by
 * seeding `{ orgSettings, partnerSettings }` straight into a db mock — they
 * bypass both the org⋈partner LEFT JOIN and RLS. This suite pins the single
 * runtime assumption the whole fix rests on, and the one this repo has been
 * bitten by before ("RLS partner-axis read needs system context"):
 *
 *   1. Under a SYSTEM context, the join returns the parent partner's
 *      settings.defaults, so a partner-locked policy actually reaches the gate.
 *   2. Under the heartbeat's ORG-scoped context (accessiblePartnerIds: []), the
 *      `partners` row is hidden by RLS, so the partner columns come back NULL
 *      and the resolver degrades to the permissive default — i.e. exactly the
 *      #2123 bug. This test therefore proves the system context is NECESSARY,
 *      not incidental: if a future refactor moved the lookup back inside the
 *      org transaction, assertion #2 would flip and fail.
 *
 * `partners` is FORCE ROW LEVEL SECURITY behind `breeze_has_partner_access(id)`
 * (migrations/2026-04-11-partners-rls.sql), which is governed by
 * `accessiblePartnerIds` — empty for the agent heartbeat path.
 *
 * Seeding runs under withSystemDbAccessContext so RLS does not hide the freshly
 * inserted rows. Fixtures are re-seeded per test (setup.ts cleanupDatabase()
 * TRUNCATEs partners/organizations CASCADE on beforeEach).
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { getOrgAgentUpdatePolicy } from '../../routes/agents/helpers';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Seed {
  orgId: string;
  partnerId: string;
}

/**
 * Seed a partner → org, with arbitrary `settings.defaults` on each side.
 * Mirrors what the settings UI writes: partner defaults live in
 * partners.settings.defaults, org-local in organizations.settings.defaults.
 */
async function seed(
  partnerDefaults: Record<string, unknown>,
  orgDefaults: Record<string, unknown>,
): Promise<Seed> {
  return withSystemDbAccessContext(async () => {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 7);

    const [partner] = await db
      .insert(partners)
      .values({
        name: `AUP Partner ${ts}-${rand}`,
        slug: `aup-tp-${ts}-${rand}`,
        type: 'msp',
        plan: 'pro',
        status: 'active',
        settings: { defaults: partnerDefaults },
      })
      .returning({ id: partners.id });
    if (!partner) throw new Error('seed: failed to insert partner');

    const [org] = await db
      .insert(organizations)
      .values({
        partnerId: partner.id,
        name: `AUP Org ${ts}-${rand}`,
        slug: `aup-org-${ts}-${rand}`,
        type: 'customer',
        status: 'active',
        settings: { defaults: orgDefaults },
      })
      .returning({ id: organizations.id });
    if (!org) throw new Error('seed: failed to insert organization');

    return { orgId: org.id, partnerId: partner.id };
  });
}

/** The exact RLS context the agent heartbeat runs its org-scoped block under. */
function orgHeartbeatContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

describe('getOrgAgentUpdatePolicy — effective resolution against real Postgres + RLS (#2123)', () => {
  runDb('system context resolves the partner-locked policy for an org with no local value', async () => {
    const { orgId } = await seed({ agentUpdatePolicy: 'manual' }, {});
    const result = await withSystemDbAccessContext(() => getOrgAgentUpdatePolicy(orgId));
    expect(result).toEqual({ policy: 'manual', maintenanceWindow: null });
  });

  runDb('system context carries the partner-locked maintenance window into the gate', async () => {
    const { orgId } = await seed(
      { agentUpdatePolicy: 'staged', maintenanceWindow: 'Sun 02:00-04:00' },
      {},
    );
    const result = await withSystemDbAccessContext(() => getOrgAgentUpdatePolicy(orgId));
    expect(result).toEqual({ policy: 'staged', maintenanceWindow: 'Sun 02:00-04:00' });
  });

  runDb('partner-locked field wins over an org-local value (system context)', async () => {
    const { orgId } = await seed({ agentUpdatePolicy: 'manual' }, { agentUpdatePolicy: 'auto' });
    const result = await withSystemDbAccessContext(() => getOrgAgentUpdatePolicy(orgId));
    expect(result.policy).toBe('manual');
  });

  runDb('org override is honored where the partner has NOT locked the field', async () => {
    const { orgId } = await seed({}, { agentUpdatePolicy: 'manual' });
    const result = await withSystemDbAccessContext(() => getOrgAgentUpdatePolicy(orgId));
    expect(result.policy).toBe('manual');
  });

  // The load-bearing assertion: proves the system context is NECESSARY. The
  // partner row is invisible under the heartbeat's org-scoped RLS context, so a
  // naive in-block lookup would silently fall back to the permissive default —
  // reintroducing #2123 with every unit test still green.
  runDb('org-scoped heartbeat context CANNOT see the partner row → permissive default (system context is necessary)', async () => {
    const { orgId } = await seed({ agentUpdatePolicy: 'manual' }, {});

    // Sanity: the SAME call under a system context sees the partner lock.
    const systemResult = await withSystemDbAccessContext(() => getOrgAgentUpdatePolicy(orgId));
    expect(systemResult.policy).toBe('manual');

    // Under the org-scoped context the partner row is RLS-hidden, so the
    // partner-locked 'manual' is invisible and we degrade to staged + no window.
    const orgResult = await withDbAccessContext(orgHeartbeatContext(orgId), () =>
      getOrgAgentUpdatePolicy(orgId),
    );
    expect(orgResult).toEqual({ policy: 'staged', maintenanceWindow: null });
  });
});
