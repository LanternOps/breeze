#!/usr/bin/env tsx
/**
 * Link existing service deliverables to their org's managed evidence definition
 * (#5784 W01, spec §5.1 item 4).
 *
 * OPT-IN and dry-run by default. Deliverables created before this feature keep
 * auto_evidence_report_id = NULL forever, and a silent mass update would start
 * producing customer-visible security artifacts for obligations the MSP never
 * wired up. The operator names the scope and confirms with --apply.
 *
 * Matching rule: a deliverable is linked only when it was created from a
 * template item that now carries an auto_evidence_report_type AND the
 * deliverable still has auto_evidence_report_id = NULL. Name-similarity
 * guessing is deliberately NOT implemented — a wrong link produces a
 * confidently wrong artifact.
 *
 *   pnpm --filter @breeze/api evidence:link --partner-id <uuid>
 *   pnpm --filter @breeze/api evidence:link --partner-id <uuid> --apply
 *   pnpm --filter @breeze/api evidence:link --org-id <uuid> --apply
 */

import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { organizations } from '../src/db/schema/orgs';
import { deliverableTemplateItems, deliverableTemplateSets } from '../src/db/schema/deliverableTemplates';
import { serviceDeliverables } from '../src/db/schema/serviceDeliverables';
import { reports } from '../src/db/schema/reports';
import { isManagedEvidenceType, type ManagedEvidenceType } from '../src/services/managedEvidenceRegistry';
import { resolveManagedEvidenceDefinition } from '../src/services/managedEvidenceDefinitions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOG = '[link-evidence-reports]';

type OrgScope = { orgId: string; partnerId: string };

type Candidate = {
  id: string;
  name: string;
  type: ManagedEvidenceType;
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Every org in scope, with the partnerId needed to also see partner-wide items. */
async function resolveOrgScope(orgId: string | undefined, partnerId: string | undefined): Promise<OrgScope[]> {
  if (orgId) {
    const [org] = await db
      .select({ id: organizations.id, partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) {
      console.warn(`${LOG} organization ${orgId} does not exist — nothing to link`);
      return [];
    }
    return [{ orgId: org.id, partnerId: org.partnerId }];
  }

  const rows = await db
    .select({ id: organizations.id, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.partnerId, partnerId!));
  return rows.map((row) => ({ orgId: row.id, partnerId: row.partnerId }));
}

/**
 * The evidence-typed template items visible to this org: its own org-owned
 * items, plus any partner-wide item from its partner (spec §5.1 — Partner-Wide
 * First). Keyed by `name::cadence` since that's the only link a deliverable
 * carries back to the item it was created from — there is no FK.
 */
async function loadEvidenceItemIndex(orgId: string, partnerId: string): Promise<Map<string, ManagedEvidenceType>> {
  const rows = await db
    .select({
      name: deliverableTemplateItems.name,
      cadence: deliverableTemplateItems.cadence,
      type: deliverableTemplateItems.autoEvidenceReportType,
    })
    .from(deliverableTemplateItems)
    .innerJoin(deliverableTemplateSets, eq(deliverableTemplateItems.setId, deliverableTemplateSets.id))
    .where(and(
      isNotNull(deliverableTemplateItems.autoEvidenceReportType),
      or(
        eq(deliverableTemplateSets.orgId, orgId),
        eq(deliverableTemplateSets.partnerId, partnerId),
      ),
    ));

  const index = new Map<string, ManagedEvidenceType>();
  for (const row of rows) {
    if (!row.type || !isManagedEvidenceType(row.type)) continue;
    const key = `${row.name}::${row.cadence}`;
    // First match wins on a name/cadence collision between an org-owned and a
    // partner-wide item — a real ambiguity, but not one this script should
    // silently resolve one way or the other differently across runs.
    if (!index.has(key)) index.set(key, row.type);
  }
  return index;
}

async function loadUnlinkedDeliverables(orgId: string): Promise<Array<{ id: string; name: string; cadence: string }>> {
  return db
    .select({
      id: serviceDeliverables.id,
      name: serviceDeliverables.name,
      cadence: serviceDeliverables.cadence,
    })
    .from(serviceDeliverables)
    .where(and(
      eq(serviceDeliverables.orgId, orgId),
      isNull(serviceDeliverables.autoEvidenceReportId),
    ));
}

async function findCandidates(orgId: string, partnerId: string): Promise<Candidate[]> {
  const [index, deliverables] = await Promise.all([
    loadEvidenceItemIndex(orgId, partnerId),
    loadUnlinkedDeliverables(orgId),
  ]);

  const candidates: Candidate[] = [];
  for (const deliverable of deliverables) {
    const type = index.get(`${deliverable.name}::${deliverable.cadence}`);
    if (!type) continue;
    candidates.push({ id: deliverable.id, name: deliverable.name, type });
  }
  return candidates;
}

// resolveManagedEvidenceDefinition stamps created_by as the principal that owns
// a freshly-provisioned definition. There is no human behind this sweep, so
// reuse a creator the org already has — same fallback as
// reprovision-portal-report-definitions.ts's existingCreator.
async function existingCreator(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ createdBy: reports.createdBy })
    .from(reports)
    .where(and(
      eq(reports.orgId, orgId),
      isNotNull(reports.createdBy),
    ))
    .limit(1);
  return row?.createdBy ?? null;
}

async function main(): Promise<void> {
  const orgIdRaw = flag('org-id');
  const partnerIdRaw = flag('partner-id');
  const ownerUserIdRaw = flag('owner-user-id');
  const apply = process.argv.includes('--apply');

  if (!orgIdRaw && !partnerIdRaw) {
    throw new Error('one of --partner-id or --org-id is required');
  }
  if (orgIdRaw && partnerIdRaw) {
    throw new Error('specify only one of --partner-id or --org-id');
  }
  if (orgIdRaw && !UUID.test(orgIdRaw)) {
    throw new Error('--org-id must be a UUID');
  }
  if (partnerIdRaw && !UUID.test(partnerIdRaw)) {
    throw new Error('--partner-id must be a UUID');
  }
  if (ownerUserIdRaw && !UUID.test(ownerUserIdRaw)) {
    throw new Error('--owner-user-id must be a UUID');
  }

  await withSystemDbAccessContext(async () => {
    const orgs = await resolveOrgScope(orgIdRaw, partnerIdRaw);
    console.log(`${LOG} ${orgs.length} organization(s) in scope`);

    let wouldLink = 0;
    let linked = 0;
    let definitionsCreated = 0;
    let definitionsAdopted = 0;

    for (const { orgId, partnerId } of orgs) {
      const candidates = await findCandidates(orgId, partnerId);
      if (candidates.length === 0) continue;

      let createdBy = ownerUserIdRaw;
      if (!createdBy) createdBy = (await existingCreator(orgId)) ?? undefined;

      if (!createdBy) {
        console.warn(
          `${LOG} SKIP org ${orgId}: no --owner-user-id and no existing report `
          + 'creator to attribute a new definition to',
        );
        continue;
      }

      for (const candidate of candidates) {
        if (!apply) {
          wouldLink += 1;
          console.log(`${LOG} would link ${candidate.name} (${orgId}) -> ${candidate.type}`);
          continue;
        }

        await db.transaction(async (tx) => {
          const definition = await resolveManagedEvidenceDefinition(orgId, candidate.type, createdBy!, tx);
          if (definition.adopted) definitionsAdopted += 1;
          else definitionsCreated += 1;

          await tx
            .update(serviceDeliverables)
            .set({ autoEvidenceReportId: definition.id })
            .where(eq(serviceDeliverables.id, candidate.id));
        });
        linked += 1;
        console.log(`${LOG} linked ${candidate.name} (${orgId}) -> ${candidate.type}`);
      }
    }

    if (!apply) {
      console.log(`${LOG} ${wouldLink} deliverables would be linked`);
    } else {
      console.log(
        `${LOG} linked ${linked} (definitions created ${definitionsCreated}, adopted ${definitionsAdopted})`,
      );
    }
  }, 'linkEvidenceReports');
}

main()
  .catch((error) => {
    console.error(`${LOG} Failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
