export interface AcceptanceCaptureInput {
  quoteId: string;
  signerName: string;
  signerEmail?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  acceptanceTokenJti?: string | null;
}

export interface AcceptanceCaptureResult {
  signerName: string;
  signerEmail: string | null;
  method: string;
}

export interface AcceptanceProvider {
  readonly kind: string;
  capture(input: AcceptanceCaptureInput): Promise<AcceptanceCaptureResult>;
}

/**
 * Built-in typed-signature provider. The signer types their full name; we record
 * it plus the method. A future DocuSign/PandaDoc adapter implements the same
 * interface and maps its envelope reference onto
 * quote_acceptances.acceptance_token_jti — same columns, no schema change.
 */
export class TypedSignatureProvider implements AcceptanceProvider {
  readonly kind = 'builtin';
  async capture(input: AcceptanceCaptureInput): Promise<AcceptanceCaptureResult> {
    const signerName = input.signerName.trim();
    if (!signerName) throw new Error('signerName is required for a typed signature');
    const email = input.signerEmail?.trim();
    return { signerName, signerEmail: email && email.length > 0 ? email : null, method: 'typed-signature' };
  }
}

let provider: AcceptanceProvider | null = null;
export function getAcceptanceProvider(): AcceptanceProvider {
  if (!provider) provider = new TypedSignatureProvider();
  return provider;
}
