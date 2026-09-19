/**
 * Partner-wide READ branch on the identity/contracts config tables
 * (#4959 sso_providers, #4960 ticket_forms, #4961 contract_templates,
 * #4962 contract_template_versions, #4963 psa_connections, #4970
 * access_reviews — the follow-up group of epic #4673).
 *
 * Migration under test:
 * 2026-10-10-100400-identity-contracts-partner-wide-select.sql.
 *
 * Every table here is `org_id` XOR `partner_id` carried directly on the row, so
 * each takes the direct-column form of the branch:
 *
 *   <table>_partner_wide_select  FOR SELECT USING (
 *     org_id IS NULL AND partner_id = public.breeze_current_partner_id()
 *   )
 *
 * Before this migration an ORG-scoped session could not see its own MSP's
 * partner-wide row at all: `breeze_has_org_access(NULL)` is false, and
 * `breeze_has_partner_access(P)` is false because org scope carries
 * `accessiblePartnerIds: []`. Readers therefore escalate through the #1105
 * pattern (`runOutsideDbContext(() => withSystemDbAccessContext(...))`), which
 * double-holds a pooled connection and bypasses RLS entirely — see the header
 * of 2026-10-05-110000-config-policy-partner-wide-select.sql, whose suite
 * (configPolicyPartnerWideSelect.integration.test.ts) this one mirrors.
 *
 * Three properties, per table, none reachable from a mocked unit test (no RLS
 * runs there) and none proven by rls-coverage either (that is a pg_catalog
 * shape inspection, not a functional one):
 *
 *  (a) an ORG session of the OWNING partner SELECTs BOTH its own org-owned row
 *      and the partner-wide row;
 *  (b) an ORG session under a DIFFERENT partner sees NEITHER;
 *  (c) the branch is READ-ONLY — that same org session cannot UPDATE or DELETE
 *      the partner-wide row. Note the denial is a silent ZERO-ROWS no-op, not a
 *      42501: RLS hides the target row from the write command rather than
 *      raising. A test that only asserted "it threw" would be vacuous, so both
 *      the returned row count AND a system-scope re-read are asserted.
 *
 * Plus the NULL-GUC guard: an agent-shaped context leaves
 * `breeze_current_partner_id()` NULL, and `partner_id = NULL` is NULL (never
 * true), so the branch must not fire. That is what keeps the predicate honest
 * as `=` rather than `IS NOT DISTINCT FROM`.
 *
 * Seeding runs under SYSTEM scope on purpose: the write policies these tables
 * already have are proven by their own `<table>PartnerRls.integration.test.ts`
 * suites, and seeding here must not depend on them.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  accessReviews,
  contractTemplates,
  contractTemplateVersions,
  psaConnections,
  ssoProviders,
  ticketForms,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

/**
 * An ORG-scoped session. `currentPartnerId` is populated from the token's
 * partnerId for org scope too (`buildDbAccessContext`, middleware/auth.ts),
 * which is exactly what the read branch keys on — so it is set deliberately.
 * `accessiblePartnerIds` stays EMPTY: an org token never passes
 * `breeze_has_partner_access`, and that is what keeps the branch read-only.
 *
 * Passing `currentPartnerId: null` yields the AGENT session shape.
 */
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

const MARKER = 'HIJACKED';

/** Cleanup thunks, run under SYSTEM scope after each test (LIFO: children first). */
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  if (cleanups.length === 0) return;
  const pending = cleanups.splice(0, cleanups.length).reverse();
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const run of pending) await run();
  });
});

interface SeededPair {
  /** Row owned by org A (`org_id` set, `partner_id` NULL). */
  orgOwnedId: string;
  /** Row owned by partner P (`org_id` NULL, `partner_id` set). */
  partnerWideId: string;
}

/**
 * One table's slice of the contract. Every closure runs inside whatever
 * `withDbAccessContext` the caller opened, so the assertions below measure RLS
 * and nothing else.
 */
interface TableCase {
  /** SQL table name — used as the test name and in failure messages. */
  table: string;
  seed(partnerId: string, orgId: string): Promise<SeededPair>;
  selectById(id: string): Promise<unknown[]>;
  /** UPDATE ... RETURNING; resolves to the rows RLS let the caller touch. */
  updateById(id: string): Promise<unknown[]>;
  /** DELETE ... RETURNING; resolves to the rows RLS let the caller touch. */
  deleteById(id: string): Promise<unknown[]>;
  /** The field `updateById` would have overwritten, read back under SYSTEM scope. */
  readMarker(id: string): Promise<string | null | undefined>;
}

const CASES: TableCase[] = [
  {
    table: 'sso_providers',
    async seed(partnerId, orgId) {
      return withDbAccessContext(SYSTEM_CTX, async () => {
        const [orgOwned] = await db
          .insert(ssoProviders)
          .values({ orgId, partnerId: null, name: 'Org IdP', type: 'oidc' })
          .returning({ id: ssoProviders.id });
        const [partnerWide] = await db
          .insert(ssoProviders)
          .values({ orgId: null, partnerId, name: 'Partner IdP', type: 'oidc' })
          .returning({ id: ssoProviders.id });
        cleanups.push(async () => {
          await db.delete(ssoProviders).where(eq(ssoProviders.id, partnerWide!.id));
          await db.delete(ssoProviders).where(eq(ssoProviders.id, orgOwned!.id));
        });
        return { orgOwnedId: orgOwned!.id, partnerWideId: partnerWide!.id };
      });
    },
    selectById: (id) => db.select().from(ssoProviders).where(eq(ssoProviders.id, id)),
    updateById: (id) =>
      db.update(ssoProviders).set({ name: MARKER }).where(eq(ssoProviders.id, id)).returning({ id: ssoProviders.id }),
    deleteById: (id) => db.delete(ssoProviders).where(eq(ssoProviders.id, id)).returning({ id: ssoProviders.id }),
    readMarker: async (id) =>
      (await db.select({ name: ssoProviders.name }).from(ssoProviders).where(eq(ssoProviders.id, id)))[0]?.name,
  },
  {
    table: 'ticket_forms',
    async seed(partnerId, orgId) {
      return withDbAccessContext(SYSTEM_CTX, async () => {
        const [orgOwned] = await db
          .insert(ticketForms)
          .values({ orgId, partnerId: null, name: 'Org intake form', fields: [], defaultTags: [] })
          .returning({ id: ticketForms.id });
        const [partnerWide] = await db
          .insert(ticketForms)
          .values({ orgId: null, partnerId, name: 'Partner intake form', fields: [], defaultTags: [] })
          .returning({ id: ticketForms.id });
        cleanups.push(async () => {
          await db.delete(ticketForms).where(eq(ticketForms.id, partnerWide!.id));
          await db.delete(ticketForms).where(eq(ticketForms.id, orgOwned!.id));
        });
        return { orgOwnedId: orgOwned!.id, partnerWideId: partnerWide!.id };
      });
    },
    selectById: (id) => db.select().from(ticketForms).where(eq(ticketForms.id, id)),
    updateById: (id) =>
      db.update(ticketForms).set({ name: MARKER }).where(eq(ticketForms.id, id)).returning({ id: ticketForms.id }),
    deleteById: (id) => db.delete(ticketForms).where(eq(ticketForms.id, id)).returning({ id: ticketForms.id }),
    readMarker: async (id) =>
      (await db.select({ name: ticketForms.name }).from(ticketForms).where(eq(ticketForms.id, id)))[0]?.name,
  },
  {
    table: 'contract_templates',
    async seed(partnerId, orgId) {
      return withDbAccessContext(SYSTEM_CTX, async () => {
        const [orgOwned] = await db
          .insert(contractTemplates)
          .values({ orgId, partnerId: null, name: 'Org MSA' })
          .returning({ id: contractTemplates.id });
        const [partnerWide] = await db
          .insert(contractTemplates)
          .values({ orgId: null, partnerId, name: 'Partner MSA' })
          .returning({ id: contractTemplates.id });
        cleanups.push(async () => {
          await db.delete(contractTemplates).where(eq(contractTemplates.id, partnerWide!.id));
          await db.delete(contractTemplates).where(eq(contractTemplates.id, orgOwned!.id));
        });
        return { orgOwnedId: orgOwned!.id, partnerWideId: partnerWide!.id };
      });
    },
    selectById: (id) => db.select().from(contractTemplates).where(eq(contractTemplates.id, id)),
    updateById: (id) =>
      db
        .update(contractTemplates)
        .set({ name: MARKER })
        .where(eq(contractTemplates.id, id))
        .returning({ id: contractTemplates.id }),
    deleteById: (id) =>
      db.delete(contractTemplates).where(eq(contractTemplates.id, id)).returning({ id: contractTemplates.id }),
    readMarker: async (id) =>
      (await db.select({ name: contractTemplates.name }).from(contractTemplates).where(eq(contractTemplates.id, id)))[0]
        ?.name,
  },
  {
    // org_id / partner_id are denormalized from the parent template, so each
    // axis needs its own parent. contract_template_versions_body_chk requires
    // body_html when source_type = 'authored'.
    table: 'contract_template_versions',
    async seed(partnerId, orgId) {
      return withDbAccessContext(SYSTEM_CTX, async () => {
        const [orgTemplate] = await db
          .insert(contractTemplates)
          .values({ orgId, partnerId: null, name: 'Org template parent' })
          .returning({ id: contractTemplates.id });
        const [partnerTemplate] = await db
          .insert(contractTemplates)
          .values({ orgId: null, partnerId, name: 'Partner template parent' })
          .returning({ id: contractTemplates.id });
        const [orgOwned] = await db
          .insert(contractTemplateVersions)
          .values({
            templateId: orgTemplate!.id,
            orgId,
            partnerId: null,
            versionNumber: 1,
            sourceType: 'authored',
            bodyHtml: '<p>Org version</p>',
          })
          .returning({ id: contractTemplateVersions.id });
        const [partnerWide] = await db
          .insert(contractTemplateVersions)
          .values({
            templateId: partnerTemplate!.id,
            orgId: null,
            partnerId,
            versionNumber: 1,
            sourceType: 'authored',
            bodyHtml: '<p>Partner version</p>',
          })
          .returning({ id: contractTemplateVersions.id });
        cleanups.push(async () => {
          await db.delete(contractTemplateVersions).where(eq(contractTemplateVersions.id, partnerWide!.id));
          await db.delete(contractTemplateVersions).where(eq(contractTemplateVersions.id, orgOwned!.id));
          await db.delete(contractTemplates).where(eq(contractTemplates.id, partnerTemplate!.id));
          await db.delete(contractTemplates).where(eq(contractTemplates.id, orgTemplate!.id));
        });
        return { orgOwnedId: orgOwned!.id, partnerWideId: partnerWide!.id };
      });
    },
    selectById: (id) => db.select().from(contractTemplateVersions).where(eq(contractTemplateVersions.id, id)),
    updateById: (id) =>
      db
        .update(contractTemplateVersions)
        .set({ bodyHtml: MARKER })
        .where(eq(contractTemplateVersions.id, id))
        .returning({ id: contractTemplateVersions.id }),
    deleteById: (id) =>
      db
        .delete(contractTemplateVersions)
        .where(eq(contractTemplateVersions.id, id))
        .returning({ id: contractTemplateVersions.id }),
    readMarker: async (id) =>
      (
        await db
          .select({ bodyHtml: contractTemplateVersions.bodyHtml })
          .from(contractTemplateVersions)
          .where(eq(contractTemplateVersions.id, id))
      )[0]?.bodyHtml,
  },
  {
    table: 'psa_connections',
    async seed(partnerId, orgId) {
      const credentials = { baseUrl: 'https://acme.atlassian.net', apiToken: 'tok' };
      return withDbAccessContext(SYSTEM_CTX, async () => {
        const [orgOwned] = await db
          .insert(psaConnections)
          .values({ orgId, partnerId: null, name: 'Customer Jira', provider: 'jira', credentials })
          .returning({ id: psaConnections.id });
        const [partnerWide] = await db
          .insert(psaConnections)
          .values({ orgId: null, partnerId, name: 'MSP Jira', provider: 'jira', credentials })
          .returning({ id: psaConnections.id });
        cleanups.push(async () => {
          await db.delete(psaConnections).where(eq(psaConnections.id, partnerWide!.id));
          await db.delete(psaConnections).where(eq(psaConnections.id, orgOwned!.id));
        });
        return { orgOwnedId: orgOwned!.id, partnerWideId: partnerWide!.id };
      });
    },
    selectById: (id) => db.select().from(psaConnections).where(eq(psaConnections.id, id)),
    updateById: (id) =>
      db.update(psaConnections).set({ name: MARKER }).where(eq(psaConnections.id, id)).returning({ id: psaConnections.id }),
    deleteById: (id) =>
      db.delete(psaConnections).where(eq(psaConnections.id, id)).returning({ id: psaConnections.id }),
    readMarker: async (id) =>
      (await db.select({ name: psaConnections.name }).from(psaConnections).where(eq(psaConnections.id, id)))[0]?.name,
  },
  {
    table: 'access_reviews',
    async seed(partnerId, orgId) {
      return withDbAccessContext(SYSTEM_CTX, async () => {
        const [orgOwned] = await db
          .insert(accessReviews)
          .values({ orgId, partnerId: null, name: 'Org access review' })
          .returning({ id: accessReviews.id });
        const [partnerWide] = await db
          .insert(accessReviews)
          .values({ orgId: null, partnerId, name: 'Partner access review' })
          .returning({ id: accessReviews.id });
        cleanups.push(async () => {
          await db.delete(accessReviews).where(eq(accessReviews.id, partnerWide!.id));
          await db.delete(accessReviews).where(eq(accessReviews.id, orgOwned!.id));
        });
        return { orgOwnedId: orgOwned!.id, partnerWideId: partnerWide!.id };
      });
    },
    selectById: (id) => db.select().from(accessReviews).where(eq(accessReviews.id, id)),
    updateById: (id) =>
      db.update(accessReviews).set({ name: MARKER }).where(eq(accessReviews.id, id)).returning({ id: accessReviews.id }),
    deleteById: (id) =>
      db.delete(accessReviews).where(eq(accessReviews.id, id)).returning({ id: accessReviews.id }),
    readMarker: async (id) =>
      (await db.select({ name: accessReviews.name }).from(accessReviews).where(eq(accessReviews.id, id)))[0]?.name,
  },
];

describe('identity-contracts tables — partner-wide SELECT branch (#4673 follow-ups)', () => {
  describe('(a) an ORG session of the OWNING partner reads its own row AND the partner-wide row', () => {
    for (const testCase of CASES) {
      it(testCase.table, async () => {
        const partner = await createPartner();
        const orgA = await createOrganization({ partnerId: partner.id });
        const { orgOwnedId, partnerWideId } = await testCase.seed(partner.id, orgA.id);

        const rows = await withDbAccessContext(orgContext(orgA.id, partner.id), async () => [
          ...(await testCase.selectById(orgOwnedId)),
          ...(await testCase.selectById(partnerWideId)),
        ]);

        expect(
          rows,
          `${testCase.table}: an org session of the owning partner must see both its own ` +
            `org-owned row and the partner-wide row`,
        ).toHaveLength(2);
      });
    }
  });

  describe('(b) an ORG session under a DIFFERENT partner sees neither row', () => {
    for (const testCase of CASES) {
      it(testCase.table, async () => {
        const owner = await createPartner();
        const orgA = await createOrganization({ partnerId: owner.id });
        const { orgOwnedId, partnerWideId } = await testCase.seed(owner.id, orgA.id);

        const other = await createPartner();
        const otherOrg = await createOrganization({ partnerId: other.id });

        const rows = await withDbAccessContext(orgContext(otherOrg.id, other.id), async () => [
          ...(await testCase.selectById(orgOwnedId)),
          ...(await testCase.selectById(partnerWideId)),
        ]);

        expect(rows, `${testCase.table}: cross-partner leak`).toHaveLength(0);
      });
    }
  });

  describe('(c) the branch is READ-ONLY — no UPDATE, no DELETE of the partner-wide row', () => {
    for (const testCase of CASES) {
      it(testCase.table, async () => {
        const partner = await createPartner();
        const orgA = await createOrganization({ partnerId: partner.id });
        const { partnerWideId } = await testCase.seed(partner.id, orgA.id);
        const ctx = orgContext(orgA.id, partner.id);

        const updated = await withDbAccessContext(ctx, () => testCase.updateById(partnerWideId));
        expect(updated, `${testCase.table}: org session UPDATEd a partner-wide row`).toHaveLength(0);
        expect(
          await withDbAccessContext(SYSTEM_CTX, () => testCase.readMarker(partnerWideId)),
          `${testCase.table}: partner-wide row was mutated`,
        ).not.toBe(MARKER);

        const deleted = await withDbAccessContext(ctx, () => testCase.deleteById(partnerWideId));
        expect(deleted, `${testCase.table}: org session DELETEd a partner-wide row`).toHaveLength(0);
        expect(
          await withDbAccessContext(SYSTEM_CTX, () => testCase.selectById(partnerWideId)),
          `${testCase.table}: partner-wide row was removed`,
        ).toHaveLength(1);
      });
    }
  });

  // The predicate must stay `partner_id = breeze_current_partner_id()`. Written
  // as `IS NOT DISTINCT FROM`, a NULL GUC (every agent session today) would
  // match NULL-partner rows instead of matching nothing.
  describe('an AGENT-shaped context (currentPartnerId NULL) does not reach the partner-wide row', () => {
    for (const testCase of CASES) {
      it(testCase.table, async () => {
        const partner = await createPartner();
        const orgA = await createOrganization({ partnerId: partner.id });
        const { orgOwnedId, partnerWideId } = await testCase.seed(partner.id, orgA.id);

        const rows = await withDbAccessContext(orgContext(orgA.id, null), async () => [
          ...(await testCase.selectById(orgOwnedId)),
          ...(await testCase.selectById(partnerWideId)),
        ]);

        // Only the org-owned row, via the pre-existing breeze_has_org_access arm.
        expect(rows, `${testCase.table}: NULL partner GUC reached a partner-wide row`).toHaveLength(1);
      });
    }
  });
});
