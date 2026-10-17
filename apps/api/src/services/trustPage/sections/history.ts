// Owner: W02f (90-day "controls met" history). W02a stub — W02f replaces the body, keeping this signature.
// buildSections (./index.ts) only calls this when the frozen config's showHistory is true.
import type { TrustPagePublicPayload } from '@breeze/shared';
import type { SectionBuildContext } from './types';

export async function buildHistory(_ctx: SectionBuildContext): Promise<TrustPagePublicPayload['history']> {
  return [];
}
