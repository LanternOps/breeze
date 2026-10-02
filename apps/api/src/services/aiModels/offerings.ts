/**
 * Partner offerings (#7600 W02, spec §5.3). W02 writers: the legacy reconcile
 * (Task 12) and enableOffering (no W02 route; W04 gates it at its route).
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { aiPlatformModels, partnerAiConnections, partnerAiModels, type PartnerAiModelRow } from '../../db/schema';
import { getListedProviderByEntryId } from '../llmProviderCatalog';

export type Offering = PartnerAiModelRow;
export type OfferingPriceSource = 'platform' | 'offering' | 'catalog' | 'linked_platform';

export class OfferingWriteError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'unpriced') {
    super(message);
    this.name = 'OfferingWriteError';
  }
}

/**
 * Spec §8: a platform offering is priced only by its platform row; a
 * connection offering by (1) its own price, (2) the catalog revision's mapped
 * + verified price, (3) its linked platform row; otherwise unpriced. The price
 * CHECK makes the four price columns all-or-none, so input is the witness.
 */
export function offeringPriceSource(
  o: Pick<Offering, 'source' | 'priceInputCentsPerM' | 'platformModelId'>,
  ctx: { platformRowPriced: boolean; catalogMapsAndVerifies: boolean },
): OfferingPriceSource | null {
  if (o.source === 'platform') return ctx.platformRowPriced ? 'platform' : null;
  if (o.priceInputCentsPerM !== null && o.priceInputCentsPerM !== undefined) return 'offering';
  if (o.source === 'catalog') return ctx.catalogMapsAndVerifies ? 'catalog' : null;
  if (o.platformModelId && ctx.platformRowPriced) return 'linked_platform';
  return null;
}

export async function listOfferings(
  partnerId: string,
  opts: { enabledOnly?: boolean; connectionId?: string | null } = {},
): Promise<Offering[]> {
  const conditions = [eq(partnerAiModels.partnerId, partnerId)];
  if (opts.enabledOnly) conditions.push(eq(partnerAiModels.enabled, true));
  if (opts.connectionId === null) conditions.push(isNull(partnerAiModels.connectionId));
  else if (opts.connectionId !== undefined) conditions.push(eq(partnerAiModels.connectionId, opts.connectionId));
  return db.select().from(partnerAiModels).where(and(...conditions)).orderBy(asc(partnerAiModels.createdAt));
}

export async function getOffering(id: string): Promise<Offering | null> {
  const [row] = await db.select().from(partnerAiModels).where(eq(partnerAiModels.id, id)).limit(1);
  return row ?? null;
}

async function platformRowPriced(platformModelId: string | null): Promise<boolean> {
  if (!platformModelId) return false;
  const [row] = await db
    .select({ input: aiPlatformModels.inputCentsPerM, output: aiPlatformModels.outputCentsPerM, read: aiPlatformModels.cacheReadCentsPerM, write: aiPlatformModels.cacheWriteCentsPerM })
    .from(aiPlatformModels)
    .where(eq(aiPlatformModels.id, platformModelId))
    .limit(1);
  return !!row && [row.input, row.output, row.read, row.write].every((v) => v !== null && v !== undefined);
}

async function catalogMapsAndVerifies(o: Offering): Promise<boolean> {
  if (o.source !== 'catalog' || !o.connectionId || !o.modelId) return false;
  const [conn] = await db
    .select({ catalogEntryId: partnerAiConnections.catalogEntryId })
    .from(partnerAiConnections)
    .where(eq(partnerAiConnections.id, o.connectionId))
    .limit(1);
  if (!conn?.catalogEntryId) return false;
  const provider = await getListedProviderByEntryId(conn.catalogEntryId);
  if (!provider) return false;
  return Object.hasOwn(provider.modelMap, o.modelId) && provider.verifiedModels.includes(o.modelId);
}

/** Spec §8: a non-platform offering with no resolvable price can't be enabled. Disabling is always allowed. */
export async function enableOffering(input: { partnerId: string; offeringId: string; enabled: boolean }): Promise<Offering> {
  const [offering] = await db
    .select()
    .from(partnerAiModels)
    .where(and(eq(partnerAiModels.id, input.offeringId), eq(partnerAiModels.partnerId, input.partnerId)))
    .limit(1);
  if (!offering) throw new OfferingWriteError('Offering not found.', 'not_found');
  if (input.enabled) {
    const source = offeringPriceSource(offering, {
      platformRowPriced: await platformRowPriced(offering.platformModelId),
      catalogMapsAndVerifies: await catalogMapsAndVerifies(offering),
    });
    if (!source) {
      throw new OfferingWriteError('Set a price for this model before enabling it (0 is valid for local models).', 'unpriced');
    }
  }
  const [updated] = await db
    .update(partnerAiModels)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(and(eq(partnerAiModels.id, input.offeringId), eq(partnerAiModels.partnerId, input.partnerId)))
    .returning();
  if (!updated) throw new OfferingWriteError('Offering not found.', 'not_found');
  return updated;
}

/** The offering a legacy call ran on: platform → (partner, platform row with this model id); connection → (connection, model id). */
export async function findOfferingIdForModel(input: { partnerId: string; connectionId: string | null; modelId: string }): Promise<string | null> {
  if (input.connectionId === null) {
    const [row] = await db
      .select({ id: partnerAiModels.id })
      .from(partnerAiModels)
      .innerJoin(aiPlatformModels, eq(aiPlatformModels.id, partnerAiModels.platformModelId))
      .where(and(
        eq(partnerAiModels.partnerId, input.partnerId),
        isNull(partnerAiModels.connectionId),
        eq(aiPlatformModels.modelId, input.modelId),
      ))
      .limit(1);
    return row?.id ?? null;
  }
  const [row] = await db
    .select({ id: partnerAiModels.id })
    .from(partnerAiModels)
    .where(and(
      eq(partnerAiModels.partnerId, input.partnerId),
      eq(partnerAiModels.connectionId, input.connectionId),
      eq(partnerAiModels.modelId, input.modelId),
    ))
    .limit(1);
  return row?.id ?? null;
}
