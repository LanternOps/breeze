#!/usr/bin/env tsx
// First-customer deliverable backfill (spec §15). Creates a partner-wide
// template set, applies it to one org (and optionally one contract), then
// attaches the vulnerability report as auto-evidence.
//
// Every id is supplied at run time; NOTHING customer-specific is committed.
//
//   pnpm --filter @breeze/api deliverables:backfill-first-customer -- \
//     --org-id <uuid> --contract-id <uuid> --owner-user-id <uuid> \
//     --effective-from 2026-10-01 [--vuln-report-id <uuid>] \
//     [--set-name "Best plan"] [--dry-run]
//
// Re-runnable: an existing set with the same (partner_id, name) is reused and
// deliverables that already exist on the target are skipped, not duplicated.

import { and, eq } from 'drizzle-orm';
import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { organizations } from '../src/db/schema/orgs';
import {
  applyTemplateSet, createTemplateSet, listTemplateSets, type TemplateActor,
} from '../src/services/deliverableTemplateService';
import { updateDeliverable } from '../src/services/serviceDeliverableService';
import type { CreateTemplateItemInput } from '@breeze/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOG = '[backfill-first-customer-deliverables]';

const VULNERABILITY_ITEM_NAME = 'Vulnerability management';

/** Spec §15. `description` stays null: it is customer-facing copy the MSP writes per client. */
const BEST_PLAN_ITEMS: CreateTemplateItemInput[] = [
  { name: 'Sign-in log review',                     cadence: 'monthly',   artifactRequired: true,  leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 0 },
  { name: 'Threat detection review',                cadence: 'monthly',   artifactRequired: true,  leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 1 },
  { name: 'Intune management',                      cadence: 'monthly',   artifactRequired: false, leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 2 },
  { name: VULNERABILITY_ITEM_NAME,                  cadence: 'monthly',   artifactRequired: true,  leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 3 },
  { name: 'Documentation and configuration audit',  cadence: 'quarterly', artifactRequired: true,  leadDays: 14, graceDays: 21, completionMode: 'on_ticket_resolve', sortOrder: 4 },
  { name: 'Firewall rule review',                   cadence: 'quarterly', artifactRequired: true,  leadDays: 14, graceDays: 21, completionMode: 'on_ticket_resolve', sortOrder: 5 },
  { name: 'VPN and access policy management',       cadence: 'monthly',   artifactRequired: false, leadDays: 7,  graceDays: 14, completionMode: 'on_ticket_resolve', sortOrder: 6 },
  { name: 'IR runbooks and tabletop',               cadence: 'annual',    artifactRequired: true,  leadDays: 30, graceDays: 30, completionMode: 'on_ticket_resolve', sortOrder: 7 },
];

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function requireUuid(name: string): string {
  const value = flag(name);
  if (!value || !UUID.test(value)) throw new Error(`--${name} is required and must be a UUID`);
  return value;
}

async function main(): Promise<void> {
  const orgId = requireUuid('org-id');
  const ownerUserId = requireUuid('owner-user-id');
  const contractId = flag('contract-id');
  const vulnReportId = flag('vuln-report-id');
  const effectiveFrom = flag('effective-from');
  const setName = flag('set-name') ?? 'Best plan';
  const dryRun = process.argv.includes('--dry-run');

  if (contractId && !UUID.test(contractId)) throw new Error('--contract-id must be a UUID');
  if (vulnReportId && !UUID.test(vulnReportId)) throw new Error('--vuln-report-id must be a UUID');
  if (effectiveFrom && !ISO_DATE.test(effectiveFrom)) throw new Error('--effective-from must be YYYY-MM-DD');

  await withSystemDbAccessContext(async () => {
    const [org] = await db.select({ partnerId: organizations.partnerId })
      .from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) throw new Error(`Organization ${orgId} does not exist`);

    // System scope: unrestricted, and canManagePartnerWidePolicies is true for it.
    const actor: TemplateActor = {
      userId: ownerUserId, scope: 'system', partnerId: org.partnerId,
      partnerOrgAccess: 'all', accessibleOrgIds: null,
    };

    if (dryRun) {
      console.log(`${LOG} DRY RUN — would create partner-wide set "${setName}" for partner ${org.partnerId} with ${BEST_PLAN_ITEMS.length} items and apply it to org ${orgId}${contractId ? ` / contract ${contractId}` : ''}.`);
      return;
    }

    const existing = (await listTemplateSets(actor, {}))
      .find((s) => s.ownerScope === 'partner' && s.partnerId === org.partnerId && s.name === setName);
    const set = existing ?? await createTemplateSet(
      { ownerScope: 'partner', name: setName, description: null, items: BEST_PLAN_ITEMS }, actor,
    );
    console.log(`${LOG} ${existing ? 'Reusing' : 'Created'} partner-wide set ${set.id} ("${set.name}") with ${set.items.length} items`);

    const result = await applyTemplateSet(orgId, set.id, {
      contractId, effectiveFrom, ownerUserId, onCollision: 'skip',
    }, actor);

    for (const created of result.created) {
      console.log(`${LOG} created deliverable ${created.id}  ${created.cadence.padEnd(10)} anchor ${created.anchorDueDate}  ${created.name}`);
    }
    for (const name of result.skipped) console.log(`${LOG} skipped (already present): ${name}`);
    console.log(`${LOG} effective_from = ${result.effectiveFrom}; ${result.created.length} created, ${result.skipped.length} skipped`);

    if (vulnReportId) {
      const target = result.created.find((c) => c.name === VULNERABILITY_ITEM_NAME);
      if (!target) {
        console.warn(`${LOG} "${VULNERABILITY_ITEM_NAME}" was skipped or absent — --vuln-report-id not applied`);
      } else {
        await updateDeliverable(orgId, target.id, { autoEvidenceReportId: vulnReportId }, {
          userId: ownerUserId, partnerId: org.partnerId, accessibleOrgIds: null,
        });
        console.log(`${LOG} attached auto-evidence report ${vulnReportId} to deliverable ${target.id}`);
      }
    }
  }, 'backfillFirstCustomerDeliverables');
}

main()
  .catch((error) => {
    console.error(`${LOG} Failed:`, error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
