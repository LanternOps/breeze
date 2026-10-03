/**
 * AI Suggested Fixes W2 — reviewed generic manual steps (fix_instructions,
 * partner-axis). The ONLY writer of that table. Routes gate writes on
 * canManagePartnerWidePolicies; reads run under the caller's RLS (an org
 * token reads its own partner's rows through the SELECT-only branch).
 */
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { reviewedInstructionsSchema, type ResearchBuiltinAction } from '@breeze/shared';
import { db } from '../../db';
import { fixInstructions, type FixInstructionsRow } from '../../db/schema';
import type { FixDiscriminator, FixOsFamily } from './signature';

export async function saveReviewedInstructions(input: {
  partnerId: string; reviewedBy: string; title: string; steps: string[]; osType: FixOsFamily | null;
}): Promise<FixInstructionsRow> {
  const parsed = reviewedInstructionsSchema.parse({ title: input.title, steps: input.steps, osType: input.osType });
  const now = new Date();
  const [row] = await db.insert(fixInstructions).values({
    partnerId: input.partnerId, title: parsed.title, steps: parsed.steps, osType: parsed.osType,
    reviewedBy: input.reviewedBy, reviewedAt: now, createdAt: now, updatedAt: now,
  }).returning();
  return row!;
}

export async function listReviewedInstructions(input: {
  partnerId: string; osType?: FixOsFamily; includeRetired?: boolean; limit?: number;
}): Promise<FixInstructionsRow[]> {
  const conds: SQL[] = [eq(fixInstructions.partnerId, input.partnerId)];
  if (!input.includeRetired) conds.push(isNull(fixInstructions.retiredAt));
  if (input.osType) conds.push(eq(fixInstructions.osType, input.osType));
  return db.select().from(fixInstructions).where(and(...conds))
    .orderBy(desc(fixInstructions.reviewedAt)).limit(Math.min(input.limit ?? 100, 200));
}

export async function retireReviewedInstructions(input: { id: string; partnerId: string }): Promise<boolean> {
  const now = new Date();
  const rows = await db.update(fixInstructions).set({ retiredAt: now, updatedAt: now })
    .where(and(eq(fixInstructions.id, input.id), eq(fixInstructions.partnerId, input.partnerId), isNull(fixInstructions.retiredAt)))
    .returning({ id: fixInstructions.id });
  return rows.length === 1;
}

/** Caller's RLS bounds visibility; null when retired or invisible. */
export async function loadActiveInstructions(id: string): Promise<FixInstructionsRow | null> {
  const [row] = await db.select().from(fixInstructions)
    .where(and(eq(fixInstructions.id, id), isNull(fixInstructions.retiredAt))).limit(1);
  return row ?? null;
}

/**
 * Typed params for re-attaching a proven built-in, from the signature's
 * STRUCTURED discriminator only. null = cannot be attached runnable.
 */
export function builtinParamsFromSignature(action: ResearchBuiltinAction, discriminator: FixDiscriminator | null): Record<string, unknown> | null {
  switch (action) {
    case 'reboot': return {};
    case 'restart_service': return discriminator?.kind === 'service' ? { serviceName: discriminator.value } : null;
    case 'kill_process': return discriminator?.kind === 'process' ? { processName: discriminator.value } : null;
    case 'disk_cleanup': return null;
  }
}
