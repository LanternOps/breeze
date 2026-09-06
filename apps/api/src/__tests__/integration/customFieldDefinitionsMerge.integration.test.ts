/**
 * Org merge reconciles duplicate custom-field keys instead of raising 23505.
 * #3257 W02, Task 4.
 *
 * `custom_field_definitions_org_key_uq (org_id, field_key)` shipped in
 * `2026-10-10-100300-custom-field-definition-integrity.sql`. That index turns
 * the table's former plain `repoint` merge policy into a **23505 that aborts
 * the entire merge** whenever the loser and the survivor both define the same
 * key — and for two orgs imported from one Datto tenant, that is every key. So
 * this is not a defensive edge case: it is the common path for exactly the
 * customers #3257 exists to serve, and it would have shipped broken.
 *
 * Why this needs a REAL merge and not just the mocked-SQL unit suite
 * (`services/orgMergeCustomExecutors.test.ts`): the unit suite pins the
 * executor's compiled SQL, but a unique-index violation is a property of
 * Postgres evaluating that SQL against real rows inside the engine's real
 * transaction. Nothing short of driving `executeOrgMerge` end to end can prove
 * the 23505 is actually gone — and a mocked test would have passed just as
 * happily on the old `repoint` policy.
 *
 * The fixture deliberately gives the loser TWO definitions: one that collides
 * with the survivor and one that does not. A test with only the colliding row
 * would pass against an executor that dropped *everything*, which is the other
 * way to make the 23505 disappear and is exactly the data loss the registry
 * note warns about.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema';
import { executeOrgMerge, previewOrgMerge } from '../../services/orgMerge';
import { createOrganization, createPartner, createUser } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SHARED_KEY = 'asset_tag';
const LOSER_ONLY_KEY = 'datto_udf7';

interface Fixture {
  partnerId: string;
  loserOrgId: string;
  survivorOrgId: string;
  actorId: string;
  actorEmail: string;
  survivorSharedId: string;
  loserSharedId: string;
}

async function seedDefinition(
  orgId: string,
  fieldKey: string,
  type: 'text' | 'number',
): Promise<string> {
  const rows = await withSystemDbAccessContext(() =>
    db.insert(customFieldDefinitions).values({
      orgId,
      partnerId: null,
      name: fieldKey,
      fieldKey,
      type,
    }).returning({ id: customFieldDefinitions.id }),
  );
  return rows[0]!.id;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const loser = await createOrganization({ partnerId: partner.id });
  const survivor = await createOrganization({ partnerId: partner.id });
  const actor = await createUser({ partnerId: partner.id });

  // The two definitions differ in `type` on purpose: the survivor's is
  // authoritative afterwards, which is precisely why the executor emits an
  // operator warning telling them to compare the two if they had diverged.
  const survivorSharedId = await seedDefinition(survivor.id, SHARED_KEY, 'text');
  const loserSharedId = await seedDefinition(loser.id, SHARED_KEY, 'number');
  await seedDefinition(loser.id, LOSER_ONLY_KEY, 'text');

  return {
    partnerId: partner.id,
    loserOrgId: loser.id,
    survivorOrgId: survivor.id,
    actorId: actor.id,
    actorEmail: actor.email,
    survivorSharedId,
    loserSharedId,
  };
}

/** Read post-merge state outside the engine's own context. */
async function definitionsUnder(orgId: string): Promise<Array<{ id: string; fieldKey: string }>> {
  return withSystemDbAccessContext(() =>
    db.select({ id: customFieldDefinitions.id, fieldKey: customFieldDefinitions.fieldKey })
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.orgId, orgId)),
  );
}

describe('org merge — duplicate custom-field keys (#3257 W02)', () => {
  let f: Fixture;
  let priorDrain: string | undefined;

  beforeEach(async () => {
    // Without this the engine waits the real 30s fence drain before opening its
    // transaction, which alone exceeds the 30s integration testTimeout.
    priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    f = await seedFixture();
  });

  afterEach(() => {
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  });

  runDb('preview reports the colliding definition as a drop before the merge runs', async () => {
    const preview = await previewOrgMerge(f.loserOrgId, f.survivorOrgId, f.partnerId);

    expect(preview.verdict).toBe('ok');
    // loserRows 2 / wouldDrop 1: an operator must be able to see that ONE of
    // the two definitions is about to be destroyed. A preview reporting
    // `wouldDrop: 0` here would present a destructive merge as lossless.
    expect(preview.tables).toEqual(
      expect.arrayContaining([
        { table: 'custom_field_definitions', policy: 'custom', loserRows: 2, wouldDrop: 1 },
      ]),
    );
  });

  runDb('merges two orgs that both define asset_tag without raising 23505', async () => {
    const result = await executeOrgMerge({
      loserOrgId: f.loserOrgId,
      survivorOrgId: f.survivorOrgId,
      partnerId: f.partnerId,
      performedBy: f.actorId,
      performedByEmail: f.actorEmail,
    });

    // The colliding definition is dropped; the non-colliding one still moves.
    // Asserting BOTH numbers is what distinguishes a correct reconcile from an
    // executor that simply deleted every loser row to dodge the 23505.
    expect(result.tables.custom_field_definitions).toEqual({ moved: 1, dropped: 1 });

    expect(result.warnings.join('\n')).toMatch(
      /custom_field_definitions: dropped 1 duplicate field definition/,
    );
    // The operator must be told whose definition now governs the key.
    expect(result.warnings.join('\n')).toMatch(/survivor's TYPE and dropdown choices are now authoritative/);
  });

  runDb("keeps the SURVIVOR's definition for the shared key and re-parents the rest", async () => {
    await executeOrgMerge({
      loserOrgId: f.loserOrgId,
      survivorOrgId: f.survivorOrgId,
      partnerId: f.partnerId,
      performedBy: f.actorId,
      performedByEmail: f.actorEmail,
    });

    const survivors = await definitionsUnder(f.survivorOrgId);
    expect(survivors.map((r) => r.fieldKey).sort()).toEqual([SHARED_KEY, LOSER_ONLY_KEY].sort());

    // Identity, not just count: the row that survived under the shared key must
    // be the SURVIVOR's original. If the executor had instead dropped the
    // survivor's row and repointed the loser's, the counts above would be
    // identical and the org would silently adopt the merged-away org's type.
    const shared = survivors.find((r) => r.fieldKey === SHARED_KEY);
    expect(shared?.id).toBe(f.survivorSharedId);
    expect(shared?.id).not.toBe(f.loserSharedId);

    // And the loser's duplicate is gone outright, not stranded under the dead
    // org shell — a stranded row is the GDPR-orphan shape this wave exists to
    // close, since the org cascade deletes by org_id.
    const gone = await withSystemDbAccessContext(() =>
      db.select({ id: customFieldDefinitions.id })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.id, f.loserSharedId)),
    );
    expect(gone).toHaveLength(0);
    expect(await definitionsUnder(f.loserOrgId)).toHaveLength(0);
  });

  runDb('leaves partner-wide definitions (org_id NULL) untouched by an org merge', async () => {
    // #2135: a partner-wide definition belongs to every org under the partner.
    // An org merge that reached it would delete a definition shared across the
    // partner's whole book of business because two of its orgs merged.
    const partnerWideKey = 'partner_wide_asset_tag';
    await withSystemDbAccessContext(() =>
      db.insert(customFieldDefinitions).values({
        orgId: null,
        partnerId: f.partnerId,
        name: partnerWideKey,
        fieldKey: partnerWideKey,
        type: 'text',
      }),
    );

    await executeOrgMerge({
      loserOrgId: f.loserOrgId,
      survivorOrgId: f.survivorOrgId,
      partnerId: f.partnerId,
      performedBy: f.actorId,
      performedByEmail: f.actorEmail,
    });

    const stillThere = await withSystemDbAccessContext(() =>
      db.select({ id: customFieldDefinitions.id })
        .from(customFieldDefinitions)
        .where(and(
          eq(customFieldDefinitions.partnerId, f.partnerId),
          sql`${customFieldDefinitions.orgId} IS NULL`,
        )),
    );
    expect(stillThere).toHaveLength(1);
  });
});
