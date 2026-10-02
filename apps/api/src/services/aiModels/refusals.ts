/**
 * §9.1a: a refusal is recorded, explained, and never a silent empty answer.
 * Sonnet 5.5 / Opus 5.5 refuse in a `cyber` category, and RMM work (malware
 * triage, suspicious scripts, persistence checks) will hit it.
 */
import type { AiSurface } from '@breeze/shared';
import { getEffectiveAssignment } from './assignments';
import { listOfferings } from './offerings';
import { resolveModel } from './resolveModel';

export const REFUSAL_DOCS_URL = 'https://docs.breezermm.com/features/ai/#model-refusals';

export interface RefusalAlternative { offeringId: string; displayName: string }

export function refusalHeadline(category: string | null): string {
  return `The model declined this request (category: ${category ?? 'unspecified'}).`;
}

export function refusalMessageText(category: string | null, alternatives: RefusalAlternative[]): string {
  const parts = [refusalHeadline(category)];
  if (alternatives.length > 0) {
    parts.push(`You can retry with another model: ${alternatives.map((a) => a.displayName).join(', ')}.`);
  }
  parts.push(`An administrator can configure a refusal fallback model: ${REFUSAL_DOCS_URL}`);
  return parts.join('\n\n');
}

/** Eligible, permitted offerings this user could switch to (only when user choice is allowed). */
export async function listRefusalAlternatives(input: {
  partnerId: string;
  orgId: string;
  userId: string | null;
  surface: AiSurface;
  excludeOfferingId: string | null;
  limit?: number;
}): Promise<RefusalAlternative[]> {
  const assignment = await getEffectiveAssignment({
    partnerId: input.partnerId, orgId: input.orgId, surface: input.surface, role: 'default',
  });
  if (!assignment.allowUserChoice) return [];
  const ids = assignment.permitted.kind === 'list'
    ? assignment.permitted.offeringIds
    : (await listOfferings(input.partnerId)).filter((o) => o.enabled).map((o) => o.id);
  const limit = input.limit ?? 5;
  const out: RefusalAlternative[] = [];
  for (const id of ids) {
    if (id === input.excludeOfferingId) continue;
    const r = await resolveModel({
      partnerId: input.partnerId, orgId: input.orgId, userId: input.userId, surface: input.surface,
      requested: { offeringId: id, origin: 'user' },
    });
    if (r.ok && r.offering.id) out.push({ offeringId: r.offering.id, displayName: r.offering.displayName });
    if (out.length >= limit) break;
  }
  return out;
}
