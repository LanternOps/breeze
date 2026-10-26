// The view DTO for the public agreement signing page (#9075 W2b, spec §5).
//
// An ALLOW-LIST, built field by field: the request id is the only internal id
// that reaches the token holder. Never spread the row — a new column (token
// bookkeeping, variable values, internal reasons) must not leak by default.

import { documentSellerLines } from '@breeze/shared/documents';
import type { AgreementRequestRow } from '../db/schema/contractDocuments';

/** Statuses a resolved, live link can present (draft never has a link;
 *  voided/expired are refused with 410 before the DTO is built). */
export type PublicAgreementStatus = 'sent' | 'viewed' | 'signed' | 'declined';

export interface PublicAgreementPresentation {
  request: {
    id: string;
    status: PublicAgreementStatus;
    label: string | null;
    coverMessage: string | null;
    expiresAt: string;
    effectiveDate: string | null;
    signedAt: string | null;
    declinedAt: string | null;
  };
  template: { name: string; versionNumber: number; sourceType: 'authored' | 'uploaded' };
  /** Sanitized agreement HTML (renderAgreementRequestHtml); null for an uploaded template. */
  html: string | null;
  /** API-relative path of the uploaded template file; null for an authored one. */
  fileUrl: string | null;
  parties: { partnerName: string; orgName: string | null };
  branding: {
    partnerName: string;
    logoUrl: string | null;
    seller: { name: string | null; lines: string[]; phone: string | null; email: string | null; website: string | null } | null;
  };
}

export interface PublicAgreementPresentationInput {
  request: AgreementRequestRow;
  /** The status to present (the GET stamps sent → viewed before building). */
  status: PublicAgreementStatus;
  template: { name: string; versionNumber: number; sourceType: 'authored' | 'uploaded' };
  html: string | null;
  fileUrl: string | null;
  partnerName: string | null;
  logoUrl: string | null;
}

const FALLBACK_PARTNER_NAME = 'your provider';

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** The frozen send-time seller snapshot as display lines (legacy/blank → null). */
function toSeller(snapshot: unknown): PublicAgreementPresentation['branding']['seller'] {
  const seller = obj(snapshot);
  if (!seller) return null;
  const address = obj(seller.address);
  return {
    name: str(seller.name),
    lines: documentSellerLines({
      address: address
        ? {
            line1: str(address.line1), line2: str(address.line2), city: str(address.city),
            region: str(address.region), postalCode: str(address.postalCode), country: str(address.country),
          }
        : null,
    }),
    phone: str(seller.phone),
    email: str(seller.email),
    website: str(seller.website),
  };
}

export function toPublicAgreementPresentation(input: PublicAgreementPresentationInput): PublicAgreementPresentation {
  const { request: row } = input;
  const partnerName = input.partnerName?.trim() || FALLBACK_PARTNER_NAME;
  return {
    request: {
      id: row.id,
      status: input.status,
      label: row.label ?? null,
      coverMessage: row.coverMessage ?? null,
      expiresAt: row.expiresAt.toISOString(),
      effectiveDate: row.effectiveDate ?? null,
      signedAt: row.signedAt ? row.signedAt.toISOString() : null,
      declinedAt: row.declinedAt ? row.declinedAt.toISOString() : null,
    },
    template: { name: input.template.name, versionNumber: input.template.versionNumber, sourceType: input.template.sourceType },
    html: input.html,
    fileUrl: input.fileUrl,
    parties: { partnerName, orgName: row.clientNameSnapshot ?? null },
    branding: { partnerName, logoUrl: input.logoUrl, seller: toSeller(row.sellerSnapshot) },
  };
}
