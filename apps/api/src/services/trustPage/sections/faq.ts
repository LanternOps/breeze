// Owner: W02f (FAQ). W02a stub — W02f replaces the bodies, keeping these signatures.
import type { TrustPagePublicPayload, TrustPublishedConfig } from '@breeze/shared';
import type { SectionBuildContext, SectionDraftContext } from './types';

export async function freezeFaq(_ctx: SectionDraftContext): Promise<TrustPublishedConfig['faq']> {
  return [];
}

export function buildFaq(_ctx: SectionBuildContext): TrustPagePublicPayload['faq'] {
  return [];
}
