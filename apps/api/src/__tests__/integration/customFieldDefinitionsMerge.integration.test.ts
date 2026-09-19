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
 *
 * W03 ADDENDUM — why the anti-shadowing trigger is classified BENIGN.
 * `2026-10-11-141000-custom-field-no-cross-axis-shadowing.sql` puts a
 * BEFORE INSERT OR UPDATE OF org_id row trigger on this table, and the merge's
 * final step is `UPDATE custom_field_definitions SET org_id = <survivor>`. That
 * makes it a candidate blocker in `orgMergeRegistry.integration.test.ts`, where
 * it is registered in ORG_ID_BENIGN_TRIGGERS. The reason is a REACHABILITY
 * argument, not an inertness one, and the last two tests in this file are what
 * keep it honest:
 *
 *   - The trigger RAISEs only when the destination org's partner already owns a
 *     partner-wide row with the same field_key. A merge is same-partner
 *     (`orgMerge.ts:289`, re-validated against fresh rows inside the merge
 *     transaction at `:605`), so the repoint never changes which partner
 *     namespace the row lives in — the loser's row already had to clear this
 *     exact check to exist at all. `merges cleanly while the partner owns
 *     partner-wide definitions` pins the reachable case.
 *   - It is NOT inert: `an existing cross-axis shadow WOULD abort the repoint`
 *     forges the shadow with the trigger disarmed and shows the merge dies on
 *     it. So BENIGN rests entirely on that state being unreachable — the
 *     migration aborts the deploy if it exists on arrival, and the trigger
 *     refuses every write that would create it afterwards (proved in
 *     `customFieldShadowing.integration.test.ts`). If either of those two
 *     guarantees is ever weakened, this table must move to
 *     ORG_ID_BLOCKING_TRIGGERS and get a `blocks-merge` policy.
 *
 * The one hole in the reachability argument is a change to
 * `organizations.partner_id`, which would move an org's definitions into a new
 * namespace without firing this trigger. No production code path does that
 * (only test fixtures), and org merge explicitly refuses cross-partner pairs.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema';
import { executeOrgMerge, previewOrgMerge } from '../../services/orgMerge';
import { pgErrorCode, pgErrorNode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

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

  afterEach(async () => {
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;

    // Belt-and-braces re-arm for the forge test below, which disables the W03
    // anti-shadowing trigger. Its own `finally` handles the ordinary paths, but
    // a test TIMEOUT does not unwind the body — vitest fails the test and moves
    // on while the awaited statement is still in flight, so the `finally` may
    // not have run when the next test starts. A trigger left disabled would not
    // fail anything: `customFieldShadowing.integration.test.ts` would simply
    // stop refusing the inserts it exists to refuse and go green on a guard
    // that is not there. `ALTER TABLE ... ENABLE TRIGGER` is idempotent, so
    // paying one statement per test in this file is the cheap side of that
    // trade. Swallow errors: this is cleanup, and a failure here must not mask
    // the real assertion failure that preceded it.
    try {
      await getTestDb().execute(sql`
        ALTER TABLE public.custom_field_definitions
          ENABLE TRIGGER custom_field_definitions_no_shadow`);
    } catch (reEnableError) {
      // Log rather than swallow silently (the convention cleanupDatabase() uses
      // for the audit_logs TRUNCATE guard in setup.ts): if this fails for a real
      // reason — lock contention, not just "the trigger isn't there" — the guard
      // is now OFF in the test DB and the next file's rejection tests will fail
      // for a reason that has nothing to do with their own code. Do not rethrow:
      // an afterEach throw would replace the actual assertion failure that
      // preceded it.
      console.error(
        'customFieldDefinitionsMerge afterEach: failed to re-enable custom_field_definitions_no_shadow — the W03 shadowing guard may be OFF in the test DB',
        reEnableError,
      );
    }
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

  /**
   * The reachable W03 case: the partner owns partner-wide keys, the loser owns
   * org keys, none of them collide (they cannot — see the header), and the
   * repoint runs the trigger once per moved row without obstructing it.
   *
   * The partner-wide row is seeded with a key that a *device* would see in the
   * same flat `devices.custom_fields` namespace as the moved rows, which is the
   * whole reason W03 exists — so this is the shape the trigger is built to
   * scrutinise, not a trivially unrelated row.
   */
  runDb('merges cleanly while the partner owns partner-wide definitions (#3257 W03)', async () => {
    await withSystemDbAccessContext(() =>
      db.insert(customFieldDefinitions).values([
        { orgId: null, partnerId: f.partnerId, name: 'Site Code', fieldKey: 'pw_site_code', type: 'text' },
        { orgId: null, partnerId: f.partnerId, name: 'Contract', fieldKey: 'pw_contract', type: 'text' },
      ]),
    );

    const result = await executeOrgMerge({
      loserOrgId: f.loserOrgId,
      survivorOrgId: f.survivorOrgId,
      partnerId: f.partnerId,
      performedBy: f.actorId,
      performedByEmail: f.actorEmail,
    });

    // Same numbers as the no-partner-wide-rows case above: the trigger fired on
    // the moved row and changed nothing.
    expect(result.tables.custom_field_definitions).toEqual({ moved: 1, dropped: 1 });

    const survivors = await definitionsUnder(f.survivorOrgId);
    expect(survivors.map((r) => r.fieldKey).sort()).toEqual([SHARED_KEY, LOSER_ONLY_KEY].sort());
  });

  /**
   * VACUITY GUARD for the BENIGN classification. The test above cannot
   * distinguish "the trigger fired and passed" from "the trigger never fired",
   * and a classification resting on the second would be wrong the moment the
   * trigger's WHERE clause changed.
   *
   * So: forge the state the trigger exists to prevent — an org-owned key under
   * the loser that shadows a partner-wide key under the same partner — by
   * disarming the trigger, inserting, and re-arming it by replaying the real
   * migration. The merge must then die on the repoint.
   *
   * This is NOT a bug being documented. It is the proof that BENIGN is earned
   * by unreachability: this state cannot exist on a database that ran the
   * migration (which aborts the deploy on pre-existing shadows) and then took
   * every subsequent write through the trigger. It is here so that a future
   * change which makes the state reachable again fails LOUDLY, in the file that
   * explains the classification, rather than as an unexplained mid-walk 23503
   * in someone's production merge.
   */
  runDb('an existing cross-axis shadow WOULD abort the repoint — BENIGN is unreachability, not inertness', async () => {
    const testDb = getTestDb();
    // Forge the state the trigger prevents. DISABLE/ENABLE rather than
    // DROP/recreate: both need table ownership (which the test role has and
    // `breeze_app` deliberately does not — see the migration header), but
    // disabling cannot drift from the shipped trigger definition the way a
    // hand-copied CREATE TRIGGER would, and replaying the migration file is not
    // an option here — its own detection block would abort on the very rows
    // this test just planted.
    await testDb.execute(sql`
      ALTER TABLE public.custom_field_definitions
        DISABLE TRIGGER custom_field_definitions_no_shadow`);
    try {
      await withSystemDbAccessContext(() =>
        db.insert(customFieldDefinitions).values([
          { orgId: null, partnerId: f.partnerId, name: 'Shadowed', fieldKey: 'pw_shadowed', type: 'text' },
          { orgId: f.loserOrgId, partnerId: null, name: 'Shadowed', fieldKey: 'pw_shadowed', type: 'text' },
        ]),
      );
    } finally {
      await testDb.execute(sql`
        ALTER TABLE public.custom_field_definitions
          ENABLE TRIGGER custom_field_definitions_no_shadow`);
    }

    // Control: the forge must actually have landed both halves of the shadow,
    // or the rejection below could come from anywhere.
    const forged = await withSystemDbAccessContext(() =>
      db.select({ id: customFieldDefinitions.id })
        .from(customFieldDefinitions)
        .where(eq(customFieldDefinitions.fieldKey, 'pw_shadowed')),
    );
    expect(forged, 'forge did not land — the assertion below would be vacuous').toHaveLength(2);

    let caught: unknown;
    try {
      await executeOrgMerge({
        loserOrgId: f.loserOrgId,
        survivorOrgId: f.survivorOrgId,
        partnerId: f.partnerId,
        performedBy: f.actorId,
        performedByEmail: f.actorEmail,
      });
    } catch (error) {
      caught = error;
    }

    // Assert on the SQLSTATE + constraint name, not the message: Drizzle wraps
    // the driver error, so `caught.message` is only its own
    // "Failed query: UPDATE custom_field_definitions ..." envelope and the
    // server's text lives on `.cause`. Matching the envelope would pass for ANY
    // failure of that UPDATE — including a 23503 or a 42501 — which is exactly
    // the wrong thing for a test whose job is to name the blocker.
    expect(caught, 'the repoint must not silently succeed over a forged shadow').toBeDefined();
    expect(pgErrorCode(caught)).toBe('P0001');
    expect(
      pgErrorNode(caught)?.constraint_name,
      'the CONSTRAINT tag on the trigger RAISE is what makes this self-identifying',
    ).toBe('custom_field_definitions_no_shadow');
    expect(String(pgErrorNode(caught)?.message)).toMatch(
      /already exists as an all-organizations field/,
    );

    // And the merge is atomic about it: the loser keeps its rows.
    expect((await definitionsUnder(f.loserOrgId)).length).toBeGreaterThan(0);
  });
});
