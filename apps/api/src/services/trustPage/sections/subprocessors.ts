// Owner: W02f (subprocessors). W02a stub — W02f replaces the bodies, keeping these signatures.
import type { TrustPagePublicPayload, TrustPublishedConfig } from '@breeze/shared';
import type { SectionBuildContext, SectionDraftContext } from './types';

export async function freezeSubprocessors(_ctx: SectionDraftContext): Promise<TrustPublishedConfig['subprocessors']> {
  return [];
}

export function buildSubprocessors(_ctx: SectionBuildContext): TrustPagePublicPayload['subprocessors'] {
  return [];
}
