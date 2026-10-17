// Owner: W02d (gated documents and access requests).
import type { TrustPagePublicPayload } from '@breeze/shared';
import type { SectionBuildContext } from './types';

/**
 * The access block opens the public request flow and carries the frozen NDA text (trimmed; blank → null).
 * It exists only when a document that was PUBLISHED as gated (frozen config) is still listed as gated.
 * A document that is gated only because its live link turned gated after the last publish still renders
 * "Available on request" (the more restrictive visibility wins, Review Focus 2), but the request flow and its
 * NDA text are publisher-authored content and reach the public page only through a publish (Ruling 20). That
 * also keeps a legacy W1-frozen page free of any W2 block until it is republished (Global Constraints).
 */
export function buildAccessBlock(ctx: SectionBuildContext): TrustPagePublicPayload['access'] {
  const frozenGated = new Set(ctx.config.documents.filter((d) => d.visibility === 'gated').map((d) => d.id));
  const offered = ctx.documents.some((d) => d.visibility === 'gated' && frozenGated.has(d.id));
  if (!offered) return null;
  const ndaText = ctx.config.ndaText?.trim() || null;
  return { ndaText };
}
