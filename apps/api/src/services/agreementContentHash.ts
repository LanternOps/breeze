// Content hash for a request-sourced signed agreement (#8865 W1b, spec §3.7 /
// §4.2). Stored as contract_documents.content_sha256 with
// content_hash_version = 1. The quote family keeps its own hash
// (quoteContentHash.ts, quote_acceptances.quote_sha256 v1/v2) — this one covers
// only what a standalone agreement request binds:
//  - 'rendered': the pinned template version + the fully-resolved variable map
//    + the locale and effective date it was rendered under;
//  - 'external': the pinned template version + the uploaded signed copy's
//    bytes hash and mime (record-signed upload).
// Same canonicalisation family as computeQuoteSha256: a plain object with
// sorted variable keys (code-unit order), JSON.stringify'd, sha256 hex. Never change version 1's
// canonical form — add a new version instead (pinned vectors in the test).
import { createHash } from 'node:crypto';

export type AgreementHashVersion = 1;

export type AgreementHashInput =
  | { kind: 'rendered'; versionSha: string; vars: Record<string, string>; renderLocale: string; effectiveDate: string }
  | { kind: 'external'; versionSha: string; bytesSha256: string; mime: string };

export function computeAgreementSha256(input: AgreementHashInput, version: AgreementHashVersion = 1): string {
  const canonical = input.kind === 'rendered'
    ? {
        version,
        kind: input.kind,
        versionSha: input.versionSha,
        // UTF-16 code-unit order, NOT localeCompare: a hash that must
        // re-verify forever cannot depend on the runtime's ICU collation.
        vars: Object.fromEntries(Object.entries(input.vars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        renderLocale: input.renderLocale,
        effectiveDate: input.effectiveDate,
      }
    : {
        version,
        kind: input.kind,
        versionSha: input.versionSha,
        bytesSha256: input.bytesSha256,
        mime: input.mime,
      };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
