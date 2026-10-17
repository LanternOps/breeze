// Owner: W02b (declared controls). W02a stub — W02b replaces the bodies, keeping these signatures.
import type { TrustPagePublicPayload } from '@breeze/shared';
import type { SectionBuildContext, SectionDraftContext } from './types';

/** The active (neither superseded nor withdrawn) declaration ids to freeze at publish. */
export async function freezeDeclarationIds(_ctx: SectionDraftContext): Promise<string[]> {
  return [];
}

/** Frozen declaration ids → public entries; withdrawn rows drop out, expired ones render `expired` (re-read at refresh). */
export async function buildDeclaredControls(_ctx: SectionBuildContext): Promise<TrustPagePublicPayload['declaredControls']> {
  return [];
}
