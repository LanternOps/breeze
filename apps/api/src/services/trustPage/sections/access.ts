// Owner: W02d (gated documents and access requests). W02a stub — W02d may replace the body, keeping this signature.
import type { TrustPagePublicPayload } from '@breeze/shared';
import type { SectionBuildContext } from './types';

/** The access block exists only when the page lists a gated document; it carries the frozen NDA text. */
export function buildAccessBlock(ctx: SectionBuildContext): TrustPagePublicPayload['access'] {
  return ctx.documents.some((d) => d.visibility === 'gated') ? { ndaText: ctx.config.ndaText } : null;
}
