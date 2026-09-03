/**
 * #4673 Wave 2 (#4675) — the agent DB context carries `currentPartnerId`, and
 * that is what makes partner-wide config reachable on agent paths WITHOUT a
 * system-context escape.
 *
 * Wave 1 shipped SELECT-only RLS branches across the configuration-policy
 * chain:
 *
 *   USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())
 *
 * `breeze_current_partner_id()` reads the `breeze.current_partner_id` GUC,
 * which `db/index.ts` SET LOCALs from `DbAccessContext.currentPartnerId`. Until
 * Wave 2 the agent context hard-coded that field to `null`, so on agent paths
 * the branch could never be true: a partner-wide policy read as ZERO ROWS with
 * no error. That silent-zero is exactly why the agent-facing resolvers had to
 * escape to a system context (`withPartnerWideVisibility`), which double-holds
 * a pooled connection and bypasses RLS wholesale (#1105, #2417).
 *
 * WHY A SEPARATE FILE FROM agentPolicyResolversPartnerWide.integration.test.ts:
 * that suite proves the RESOLVERS return partner-wide config, but it passes
 * today with `currentPartnerId: null` because the resolvers still escalate
 * internally. It therefore cannot detect whether Wave 2 works. This suite
 * removes that confound by issuing PLAIN, UN-ESCALATED queries under the agent
 * context and letting RLS alone decide — which is the precondition Wave 3
 * depends on before it deletes the escapes.
 *
 * The load-bearing test in here is the NEGATIVE CONTROL
 * ("the pre-Wave-2 agent context sees nothing"): it re-runs the identical query
 * under an otherwise identical context whose only difference is
 * `currentPartnerId: null`. Without it, every positive assertion below could be
 * satisfied by some unrelated policy widening and nobody would notice.
 *
 * If this file were deleted: flipping `currentPartnerId` back to `null` in
 * agentAuth.ts / heartbeat.ts / reliability.ts / agentWs.ts would compile,
 * pass every unit test (they mock the DB and never evaluate RLS), and pass the
 * resolver suite (which escalates) — while silently cutting every agent off
 * from its MSP's shared configuration.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyEventLogSettings,
  devices,
  organizations,
} from '../../db/schema';
import { buildEventLogConfigUpdate, EVENT_LOG_DEFAULTS } from '../../routes/agents/helpers';
import { getRedis } from '../../services/redis';
import { createPartner, createOrganization, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

/**
 * The POST-Wave-2 agent context, byte-for-byte the shape agentAuth.ts now
 * builds (and that heartbeat.ts / reliability.ts / agentWs.ts hand-build from
 * `agent.partnerId`).
 *
 * Note `accessiblePartnerIds: []`. That array gates `breeze_has_partner_access`
 * — the partner-AXIS predicate that admits WRITES. Leaving it empty while
 * setting `currentPartnerId` is the whole point: read visibility widens, write
 * capability does not. If a future edit fills this array, the write assertions
 * further down are what should start failing.
 */
function agentContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: partnerId,
    userId: null,
  };
}

/** The PRE-Wave-2 agent context — identical except for the one field. */
function legacyAgentContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
    userId: null,
  };
}

const createdPolicies: string[] = [];
const createdDevices: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdDevices) {
      await db.delete(devices).where(eq(devices.id, id));
    }
    for (const id of createdPolicies) {
      await db.delete(configurationPolicies).where(eq(configurationPolicies.id, id));
    }
  });
  createdDevices.length = 0;
  createdPolicies.length = 0;
});

async function seedDevice(orgId: string, siteId: string) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [d] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `agent-${randomUUID()}`,
        hostname: `host-${randomUUID().slice(0, 8)}`,
        osType: 'windows',
        osVersion: '1.0',
        architecture: 'amd64',
        agentVersion: '1.0.0',
        status: 'online',
        deviceRole: 'workstation',
      })
      .returning();
    createdDevices.push(d!.id);
    return d!;
  });
}

/**
 * Seeds a partner-wide (`org_id NULL`) event_log policy plus its feature link,
 * settings row and partner-level assignment — i.e. the whole chain an agent
 * must traverse, not just the head row.
 */
async function seedPartnerWideEventLogPolicy(partnerId: string, maxEventsPerCycle: number) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: null,
        partnerId,
        name: `w02 event_log policy ${randomUUID()}`,
        status: 'active',
      })
      .returning();
    createdPolicies.push(policy!.id);
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'event_log' })
      .returning();
    const [settings] = await db
      .insert(configPolicyEventLogSettings)
      .values({ featureLinkId: link!.id, maxEventsPerCycle })
      .returning();
    const [assignment] = await db
      .insert(configPolicyAssignments)
      .values({ configPolicyId: policy!.id, level: 'partner', targetId: partnerId, priority: 0 })
      .returning();
    return {
      policyId: policy!.id,
      linkId: link!.id,
      settingsId: settings!.id,
      assignmentId: assignment!.id,
    };
  });
}

/**
 * Drizzle wraps the driver error, so the pg SQLSTATE lives on `.cause` — a bare
 * `rejects.toThrow(/42501/)` matches the wrapper's "Failed query: ..." text and
 * would pass for ANY failure (a typo, a NOT NULL violation). Unwrap and assert
 * the code.
 */
async function captureCause(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } }).cause;
  }
}

async function purgeEventLogCache(deviceId: string) {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`eventlog:settings:device:${deviceId}`);
}

/** A plain, UN-escalated read of the policy head row under whatever context is active. */
function readPartnerWidePolicy(policyId: string) {
  return db
    .select({ id: configurationPolicies.id, name: configurationPolicies.name })
    .from(configurationPolicies)
    .where(eq(configurationPolicies.id, policyId));
}

describe('#4673 W02 — agent context currentPartnerId unlocks partner-wide reads', () => {
  // Non-vacuity guard, FIRST. Every negative assertion in this file ("the
  // foreign partner sees zero rows", "the legacy context sees zero rows", "the
  // UPDATE affects zero rows") passes trivially if the code-under-test pool is
  // a BYPASSRLS superuser — and equally, the POSITIVE assertions would pass for
  // the wrong reason, since a BYPASSRLS role sees partner-wide rows regardless
  // of the GUC. A worktree missing its `.env.test` is exactly how that happens.
  // Fail loudly here rather than reporting a green suite that proved nothing.
  it('runs as a non-BYPASSRLS role with RLS actually enforced', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const rows = await withDbAccessContext(agentContext(org!.id, partner.id), () =>
      db.execute(
        sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      ),
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.rolbypassrls).toBe(false);
  });

  describe('the device auth join resolves the owning MSP', () => {
    // agentAuth.ts and agentWs.ts both resolve the partner id with
    // `.from(devices).innerJoin(organizations, eq(organizations.id, devices.orgId))`.
    // This pins that join against the REAL schema: a wrong join column or a
    // nullable assumption here would feed a wrong (or null) partner into every
    // context below, and the unit tests — which mock drizzle entirely — cannot
    // tell the difference.
    it('yields the org owning partner for an authenticated device', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);

      const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .select({ orgId: devices.orgId, partnerId: organizations.partnerId })
          .from(devices)
          .innerJoin(organizations, eq(organizations.id, devices.orgId))
          .where(eq(devices.agentId, device.agentId))
          .limit(1),
      );

      expect(row?.orgId).toBe(org!.id);
      expect(row?.partnerId).toBe(partner.id);
    });
  });

  describe('positive: the agent sees its own MSP partner-wide config with NO escalation', () => {
    it('reads the partner-wide policy head row under a plain org-scoped context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const { policyId } = await seedPartnerWideEventLogPolicy(partner.id, 555);

      const rows = await withDbAccessContext(agentContext(org!.id, partner.id), () =>
        readPartnerWidePolicy(policyId),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(policyId);
    });

    it('reads the whole chain — feature link, settings child and assignment', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const { linkId, settingsId, assignmentId } = await seedPartnerWideEventLogPolicy(
        partner.id,
        556,
      );

      const seen = await withDbAccessContext(agentContext(org!.id, partner.id), async () => {
        const links = await db
          .select({ id: configPolicyFeatureLinks.id })
          .from(configPolicyFeatureLinks)
          .where(eq(configPolicyFeatureLinks.id, linkId));
        const settings = await db
          .select({ id: configPolicyEventLogSettings.id, max: configPolicyEventLogSettings.maxEventsPerCycle })
          .from(configPolicyEventLogSettings)
          .where(eq(configPolicyEventLogSettings.id, settingsId));
        const assignments = await db
          .select({ id: configPolicyAssignments.id })
          .from(configPolicyAssignments)
          .where(eq(configPolicyAssignments.id, assignmentId));
        return { links, settings, assignments };
      });

      // The EXISTS-join children route back to configuration_policies, so a
      // branch present on the head row but missing on a child would show up
      // here as a partially-visible chain — config that resolves to defaults
      // for no visible reason.
      expect(seen.links).toHaveLength(1);
      expect(seen.settings).toHaveLength(1);
      expect(seen.settings[0]?.max).toBe(556);
      expect(seen.assignments).toHaveLength(1);
    });

    it('delivers the partner-wide value through the real agent config resolver', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org!.id });
      const device = await seedDevice(org!.id, site!.id);
      await purgeEventLogCache(device.id);

      await seedPartnerWideEventLogPolicy(partner.id, 557);

      const result = await withDbAccessContext(agentContext(org!.id, partner.id), () =>
        buildEventLogConfigUpdate(device.id),
      );

      // 557 is not the 100 default — the partner-wide policy genuinely resolved
      // rather than silently falling back.
      expect(result.max_events_per_cycle).toBe(557);
      expect(result.max_events_per_cycle).not.toBe(EVENT_LOG_DEFAULTS.maxEventsPerCycle);
    });
  });

  describe('negative control: the PRE-Wave-2 context (currentPartnerId null) sees nothing', () => {
    // This is what makes every positive assertion above non-vacuous. Same
    // partner, same org, same rows, same query — the ONLY difference is the
    // field Wave 2 populates. If this ever starts returning rows, the branch is
    // matching for some reason other than the GUC and the positives prove
    // nothing.
    it('returns zero rows for the identical query with currentPartnerId null', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const { policyId } = await seedPartnerWideEventLogPolicy(partner.id, 558);

      const withPartner = await withDbAccessContext(agentContext(org!.id, partner.id), () =>
        readPartnerWidePolicy(policyId),
      );
      const withoutPartner = await withDbAccessContext(legacyAgentContext(org!.id), () =>
        readPartnerWidePolicy(policyId),
      );

      expect(withPartner).toHaveLength(1);
      expect(withoutPartner).toHaveLength(0);
    });

    it('confirms the GUC is what the branch keys on', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const guc = await withDbAccessContext(agentContext(org!.id, partner.id), () =>
        db.execute(sql`select public.breeze_current_partner_id() as pid`),
      );
      const legacyGuc = await withDbAccessContext(legacyAgentContext(org!.id), () =>
        db.execute(sql`select public.breeze_current_partner_id() as pid`),
      );

      expect((guc as unknown as Array<{ pid: string | null }>)[0]?.pid).toBe(partner.id);
      // Fail-closed: an empty GUC resolves to NULL, and `partner_id = NULL` is
      // never true — it does not error, it just matches nothing.
      expect((legacyGuc as unknown as Array<{ pid: string | null }>)[0]?.pid).toBeNull();
    });
  });

  describe('isolation: a FOREIGN MSP partner-wide config stays invisible', () => {
    it('does not leak partner Q rows to an agent of partner P', async () => {
      const partnerP = await createPartner();
      const orgP = await createOrganization({ partnerId: partnerP.id });
      const partnerQ = await createPartner();
      const { policyId: qPolicyId } = await seedPartnerWideEventLogPolicy(partnerQ.id, 559);

      const rows = await withDbAccessContext(agentContext(orgP!.id, partnerP.id), () =>
        readPartnerWidePolicy(qPolicyId),
      );

      expect(rows).toHaveLength(0);
    });

    it('does not deliver a foreign MSP partner-wide policy through the resolver', async () => {
      const partnerP = await createPartner();
      const orgP = await createOrganization({ partnerId: partnerP.id });
      const siteP = await createSite({ orgId: orgP!.id });
      const deviceP = await seedDevice(orgP!.id, siteP!.id);
      await purgeEventLogCache(deviceP.id);

      const partnerQ = await createPartner();
      await seedPartnerWideEventLogPolicy(partnerQ.id, 560);

      const result = await withDbAccessContext(agentContext(orgP!.id, partnerP.id), () =>
        buildEventLogConfigUpdate(deviceP.id),
      );

      expect(result.max_events_per_cycle).toBe(EVENT_LOG_DEFAULTS.maxEventsPerCycle);
      expect(result.max_events_per_cycle).not.toBe(560);
    });
  });

  describe('the widening is READ-ONLY: writes are not targetable', () => {
    // Wave 1's branches are FOR SELECT. Postgres does not consult FOR SELECT
    // policies when computing UPDATE/DELETE target rows, so a partner-wide row
    // an agent can READ must still be un-writable. RLS hides it from the write
    // command silently — 0 rows affected, NOT a 42501 — so these assertions
    // MUST check the row count. Asserting "no error" would pass trivially.
    it('UPDATE against a visible partner-wide policy affects zero rows', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const { policyId } = await seedPartnerWideEventLogPolicy(partner.id, 561);

      const { visible, updated } = await withDbAccessContext(
        agentContext(org!.id, partner.id),
        async () => {
          const visible = await readPartnerWidePolicy(policyId);
          const updated = await db
            .update(configurationPolicies)
            .set({ name: 'hijacked-by-agent' })
            .where(eq(configurationPolicies.id, policyId))
            .returning({ id: configurationPolicies.id });
          return { visible, updated };
        },
      );

      expect(visible).toHaveLength(1); // readable ...
      expect(updated).toHaveLength(0); // ... but not writable.

      // And the row is genuinely untouched, checked from a system context so
      // the assertion cannot itself be fooled by RLS.
      const [after] = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .select({ name: configurationPolicies.name })
          .from(configurationPolicies)
          .where(eq(configurationPolicies.id, policyId)),
      );
      expect(after?.name).not.toBe('hijacked-by-agent');
    });

    it('DELETE against a visible partner-wide policy affects zero rows', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const { policyId } = await seedPartnerWideEventLogPolicy(partner.id, 562);

      const deleted = await withDbAccessContext(agentContext(org!.id, partner.id), () =>
        db
          .delete(configurationPolicies)
          .where(eq(configurationPolicies.id, policyId))
          .returning({ id: configurationPolicies.id }),
      );
      expect(deleted).toHaveLength(0);

      const survivors = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .select({ id: configurationPolicies.id })
          .from(configurationPolicies)
          .where(eq(configurationPolicies.id, policyId)),
      );
      expect(survivors).toHaveLength(1);
    });

    it('INSERT of a forged partner-wide policy is refused (42501)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      // An agent can now READ this partner's partner-wide rows; it must still
      // be unable to MINT one. Wave 1 touched no INSERT policy / WITH CHECK, so
      // this is the loud failure mode (unlike UPDATE/DELETE above, which are
      // silent 0-row no-ops).
      const cause = await captureCause(() =>
        withDbAccessContext(agentContext(org!.id, partner.id), () =>
          db.insert(configurationPolicies).values({
            orgId: null,
            partnerId: partner.id,
            name: `forged by agent ${randomUUID()}`,
            status: 'active',
          }),
        ),
      );

      expect(cause?.code).toBe('42501');
      expect(cause?.message).toMatch(/new row violates row-level security policy/i);
    });
  });

  describe('org-owned rows are unaffected by the new branch', () => {
    it('still sees its own org policies, and still cannot see another org rows', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const [policyA] = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(configurationPolicies)
          .values({ orgId: orgA!.id, partnerId: null, name: `org A ${randomUUID()}`, status: 'active' })
          .returning(),
      );
      createdPolicies.push(policyA!.id);
      const [policyB] = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(configurationPolicies)
          .values({ orgId: orgB!.id, partnerId: null, name: `org B ${randomUUID()}`, status: 'active' })
          .returning(),
      );
      createdPolicies.push(policyB!.id);

      const seen = await withDbAccessContext(agentContext(orgA!.id, partner.id), async () => ({
        own: await readPartnerWidePolicy(policyA!.id),
        // Same partner, DIFFERENT org. The new branch is `org_id IS NULL AND
        // partner_id = ...`; if it were ever loosened to "same partner", this
        // sibling org's row would become visible and cross-tenant isolation
        // inside one MSP would be gone.
        sibling: await readPartnerWidePolicy(policyB!.id),
      }));

      expect(seen.own).toHaveLength(1);
      expect(seen.sibling).toHaveLength(0);
    });
  });
});
