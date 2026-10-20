/**
 * #9346 — fold a hand-built DRAFT contract into another contract of the same
 * org, normally the draft a quote accept created next to it.
 *
 * The quote-created contract is the canonical one: it carries the signed prices
 * and its signed agreement snapshot cannot be re-filed elsewhere
 * (contractDocumentService ALREADY_LINKED). So the operator keeps it and folds
 * the hand-built draft in: every deliverable on the draft (active or not) moves
 * across through #9302's move logic, including its name-collision check;
 * signed agreements and agreement requests filed under the draft are re-linked
 * (both FKs are ON DELETE SET NULL, so deleting the draft first would silently
 * orphan them); then the draft is deleted. Its LINES are not copied — the
 * target's lines are the ones the customer signed.
 *
 * One transaction (a savepoint inside a request): any failure leaves both
 * contracts exactly as they were.
 */
import { and, eq } from 'drizzle-orm';
import type { AdoptDraftContractInput, AdoptDraftContractResult } from '@breeze/shared';
import { db } from '../db';
import { agreementRequests, contractDocuments } from '../db/schema/contractDocuments';
import { contracts } from '../db/schema/contracts';
import { serviceDeliverables } from '../db/schema/serviceDeliverables';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { lockContractRow, requireWholeContractSiteAccess } from './contractService';
import { ContractServiceError, type ContractActor } from './contractTypes';
import { DeliverableServiceError, moveDeliverablesWithin } from './serviceDeliverableService';

const ADOPTABLE_TARGET_STATUSES = new Set(['draft', 'active']);

function notFound(): never {
  throw new ContractServiceError('Contract not found', 404, 'CONTRACT_NOT_FOUND');
}

function duplicateName(names: string[]): never {
  throw new ContractServiceError(
    'A deliverable with this name already exists on this contract', 409, 'DUPLICATE_NAME', { names },
  );
}

function raced(): never {
  throw new ContractServiceError('The contracts changed while the draft was being adopted; try again', 409, 'INVALID_STATE');
}

/** Re-throw the move service's errors in the contract routes' envelope. Only
 *  wraps the deliverable move — nothing else in the adopt is mapped here. */
function mapMoveError(err: unknown): never {
  if (err instanceof DeliverableServiceError && err.code === 'DUPLICATE_NAME') {
    const names = (err.details as { names?: unknown } | undefined)?.names;
    duplicateName(Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []);
  }
  // A deliverable vanished between read and move (404), MOVE_INCOMPLETE, or a
  // concurrent insert of the same name on the target won the unique index:
  // all three are a concurrent writer racing us, and we cannot name the
  // colliding row — surface a retryable 409 rather than an empty name list.
  if (err instanceof DeliverableServiceError || isPgUniqueViolation(err)) raced();
  throw err;
}

export async function adoptDraftContract(
  targetId: string, input: AdoptDraftContractInput, actor: ContractActor,
): Promise<AdoptDraftContractResult> {
  const sourceId = input.sourceContractId;
  if (sourceId === targetId) {
    throw new ContractServiceError('A contract cannot adopt itself', 400, 'ADOPT_SELF');
  }
  // Every failure is thrown inside the callback, so the savepoint rolls the
  // whole adopt back; the request transaction itself stays usable.
  return db.transaction(async (tx) => {
    // Lock both rows in id order, so two opposite adopts (X←Y, Y←X) queue
    // instead of deadlocking. Under RLS another tenant's id reads as absent.
    const [firstId, secondId] = targetId < sourceId ? [targetId, sourceId] : [sourceId, targetId];
    const first = await lockContractRow(tx, firstId);
    const second = await lockContractRow(tx, secondId);
    const target = first.id === targetId ? first : second;
    const source = first.id === sourceId ? first : second;

    if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(target.orgId)) {
      throw new ContractServiceError('Organization access denied', 403, 'ORG_DENIED');
    }
    // A draft in another org — even one this caller can see — is not a
    // candidate: same 404 as a missing id, so nothing about it is revealed.
    if (source.orgId !== target.orgId) notFound();
    // Site axis (app-layer only): this rewrites one contract and deletes the
    // other, so the caller must reach every line of both — the bar
    // deleteDraftContract sets for the delete alone.
    await requireWholeContractSiteAccess(actor, target.id, tx);
    await requireWholeContractSiteAccess(actor, source.id, tx);

    if (source.status !== 'draft') {
      throw new ContractServiceError('Only a draft contract can be adopted', 400, 'ADOPT_SOURCE_NOT_DRAFT');
    }
    if (!ADOPTABLE_TARGET_STATUSES.has(target.status)) {
      throw new ContractServiceError('Only a draft or active contract can adopt a draft', 400, 'ADOPT_TARGET_INVALID_STATE');
    }

    // Every deliverable, active or not: a deactivated one left behind would
    // fall to standalone when the draft is deleted (FK SET NULL).
    const sourceDeliverables = await tx.select({ id: serviceDeliverables.id }).from(serviceDeliverables)
      .where(and(eq(serviceDeliverables.orgId, source.orgId), eq(serviceDeliverables.contractId, source.id)));
    let movedDeliverables = 0;
    if (sourceDeliverables.length > 0) {
      try {
        movedDeliverables = await moveDeliverablesWithin(
          tx, target.orgId, sourceDeliverables.map((d) => d.id), target.id,
        );
      } catch (err) { mapMoveError(err); }
    }

    const movedDocs = await tx.update(contractDocuments)
      .set({ contractId: target.id })
      .where(and(eq(contractDocuments.orgId, source.orgId), eq(contractDocuments.contractId, source.id)))
      .returning({ id: contractDocuments.id });
    const movedRequests = await tx.update(agreementRequests)
      .set({ contractId: target.id, updatedAt: new Date() })
      .where(and(eq(agreementRequests.orgId, source.orgId), eq(agreementRequests.contractId, source.id)))
      .returning({ id: agreementRequests.id });

    // Lines, billing periods and hour periods cascade, as deleteDraftContract.
    const deleted = await tx.delete(contracts).where(eq(contracts.id, source.id)).returning({ id: contracts.id });
    if (deleted.length !== 1) notFound();

    return {
      target: { id: target.id, orgId: target.orgId, name: target.name },
      source: { id: source.id, orgId: source.orgId, name: source.name },
      movedDeliverables,
      movedDocuments: movedDocs.length,
      movedAgreementRequests: movedRequests.length,
    };
  });
}
