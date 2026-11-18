// Signature-certificate versions (#10513).
//
// The certificate is DERIVED on demand (agreementCertificate.ts), so changing
// its wording would silently rewrite the certificate of every agreement signed
// earlier. Signed evidence must not change after the fact, so the wording is
// versioned: contract_documents.certificate_version is stamped once, at signing
// (freezeSignedAgreement), and the renderer prints the wording of THAT version
// forever after (the append-only trigger freezes the column like every other
// evidence column).
//
//   1 — NULL in the column: every agreement signed before #10513. The token
//       channel reads "Electronically accepted via emailed link".
//   2 — the token channel reads "Electronically accepted via signing link"
//       (a technician may have copied the link and shared it another way, so
//       "emailed" was not always true). Nothing else changed.
//
// A wording change on the certificate page is a NEW version: add it here, bump
// CURRENT_CERTIFICATE_VERSION, keep every older branch rendering byte-for-byte
// what it rendered before. NULL is the only encoding of v1
// (contract_documents_certificate_version_chk rejects a stored 1).
//
// Every insert path MUST write CURRENT_CERTIFICATE_VERSION explicitly. The DB
// default (2) only covers pre-#10513 code inserting mid-rollout; after a bump
// to v3 it would silently stamp v2 on an insert that forgot the column.

export type CertificateVersion = 1 | 2;

/** The version every new signature is stamped with. */
export const CURRENT_CERTIFICATE_VERSION = 2 as const satisfies CertificateVersion;

/**
 * The stored column → the version to render. Throws on a value this build does
 * not know (a row stamped by a newer build, read after a rollback): printing
 * another version's wording on signed evidence is worse than a loud failure.
 */
export function certificateVersionFromColumn(stored: number | null): CertificateVersion {
  if (stored === null) return 1;
  if (stored === 2) return 2;
  throw new Error(`Unknown signature certificate version ${stored} (this build renders NULL = v1 and 2)`);
}
