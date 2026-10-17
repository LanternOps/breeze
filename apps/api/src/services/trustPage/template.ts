// Owner: W02g (partner-wide trust page template, shape 3). W02a stub — W02g replaces the body, keeping this
// signature. null = the partner has no template row (every setting falls through to the built-in default).
import type { TrustTemplateSettings } from '@breeze/shared';

export async function loadPartnerTemplate(_partnerId: string): Promise<{ settings: TrustTemplateSettings; revision: number } | null> {
  return null;
}
