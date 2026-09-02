import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgents } from '../../db/schema';
import { resolveEffectiveAgent } from '../../services/aiAgents/effectivePolicy';
import type { AuthContext } from '../../middleware/auth';
import { AI_AGENT_POLICY_SNAPSHOT_VERSION } from '@breeze/shared';
import { createOrganization, createPartner, createUser } from './db-utils';

// resolveEffectiveAgent against REAL Postgres. A mocked-DB unit test cannot
// cover this: the partner-wide row is invisible to an org-scoped RLS context
// (breeze.accessible_partner_ids is [] for scope='organization'), and the read
// returns ZERO ROWS rather than raising — so a missing elevation silently
// resolves every agent to "no baseline" instead of failing loudly (#2822).

const createdAgents: string[] = [];
const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  if (!createdAgents.length) return;
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.delete(aiAgents).where(inArray(aiAgents.id, createdAgents)),
  );
  createdAgents.length = 0;
});

function orgContext(orgId: string, currentPartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

const AUTH = { canAccessOrg: () => true } as unknown as AuthContext;

async function seed(opts: { partnerWide: boolean; org: boolean }) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });

  if (opts.partnerWide) {
    const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiAgents).values({
        orgId: null, partnerId: partner.id, kind: 'triage', name: 'Partner Triage',
        createdBy: user.id, enabled: true, mode: 'shadow',
        toolAllowlist: ['run_script', 'get_device'],
        limits: { maxDevicesPerRun: 10 },
      }).returning());
    createdAgents.push(row!.id);
  }
  if (opts.org) {
    const [row] = await withDbAccessContext(SYSTEM_CTX, () =>
      db.insert(aiAgents).values({
        orgId: org.id, partnerId: null, kind: 'triage', name: 'Org Triage',
        createdBy: user.id, enabled: true, mode: 'act',
        toolAllowlist: ['run_script', 'reboot_device'],
        limits: { maxDevicesPerRun: 50 },
      }).returning());
    createdAgents.push(row!.id);
  }
  return { partner, org };
}

describe('resolveEffectiveAgent under real RLS', () => {
  it('reads the partner baseline from an ORG-scoped context and tightens to it', async () => {
    const { partner, org } = await seed({ partnerWide: true, org: true });

    // Proof that the elevation is load-bearing: the SAME context reading the
    // table directly cannot see the partner-wide row at all. Without
    // readWithPartnerAxisVisibility the resolver sees exactly this — zero rows,
    // no error — and every agent silently resolves to "no baseline".
    const directlyVisible = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.select().from(aiAgents),
    );
    expect(directlyVisible.some((r) => r.orgId === null)).toBe(false);

    const resolved = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      resolveEffectiveAgent(AUTH, org.id, 'triage'),
    );
    // If the partner-axis elevation were missing this would be null, not a merge.
    expect(resolved, 'partner-wide baseline was invisible to the org context').not.toBeNull();
    expect(resolved!.effective.mode).toBe('shadow');            // org asked for 'act'
    expect(resolved!.effective.toolAllowlist).toEqual(['run_script']); // intersection
    expect(resolved!.effective.limits.maxDevicesPerRun).toBe(10);      // org asked for 50
    expect(resolved!.schemaVersion).toBe(AI_AGENT_POLICY_SNAPSHOT_VERSION);
  });

  it('the platform kill switch forces every resolved agent off', async () => {
    // The resolver's half of the kill switch had no coverage at all: it read a
    // module-level const, so no test could flip it. Both halves now read
    // envFlag at call time.
    const { partner, org } = await seed({ partnerWide: true, org: true });
    const previous = process.env.BREEZE_AI_AGENTS_ENABLED;
    process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
    const on = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      resolveEffectiveAgent(AUTH, org.id, 'triage'));
    expect(on!.effective.enabled).toBe(true);

    process.env.BREEZE_AI_AGENTS_ENABLED = 'false';
    const off = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      resolveEffectiveAgent(AUTH, org.id, 'triage'));
    expect(off!.effective.enabled).toBe(false);
    if (previous === undefined) delete process.env.BREEZE_AI_AGENTS_ENABLED;
    else process.env.BREEZE_AI_AGENTS_ENABLED = previous;
  });

  it('denies a caller that cannot access the org, before reading anything', async () => {
    const { partner, org } = await seed({ partnerWide: true, org: true });
    const denied = { canAccessOrg: () => false } as unknown as AuthContext;
    await expect(
      withDbAccessContext(orgContext(org.id, partner.id), () =>
        resolveEffectiveAgent(denied, org.id, 'triage')),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('an org row alone can never self-enable the agent', async () => {
    const { partner, org } = await seed({ partnerWide: false, org: true });
    const resolved = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      resolveEffectiveAgent(AUTH, org.id, 'triage'),
    );
    expect(resolved).toBeNull();
  });

  it('a soft-deleted partner baseline stops being a baseline', async () => {
    const { partner, org } = await seed({ partnerWide: true, org: true });
    await withDbAccessContext(SYSTEM_CTX, () =>
      db.update(aiAgents).set({ disabledAt: new Date() }).where(inArray(aiAgents.id, createdAgents)),
    );
    const resolved = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      resolveEffectiveAgent(AUTH, org.id, 'triage'),
    );
    expect(resolved).toBeNull();
  });
});
