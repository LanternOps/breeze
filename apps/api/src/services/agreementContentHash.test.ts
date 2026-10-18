import { describe, expect, it } from 'vitest';
import { computeAgreementSha256, type AgreementHashInput } from './agreementContentHash';

const VERSION_SHA = 'a'.repeat(64);
const rendered: AgreementHashInput = {
  kind: 'rendered',
  versionSha: VERSION_SHA,
  vars: { 'client.name': 'Acme Co', 'seller.name': 'MSP LLC', 'dates.effective': 'Oct 01, 2026' },
  renderLocale: 'en',
  effectiveDate: '2026-10-01',
};
const external: AgreementHashInput = {
  kind: 'external',
  versionSha: VERSION_SHA,
  bytesSha256: 'b'.repeat(64),
  mime: 'application/pdf',
};

describe('computeAgreementSha256', () => {
  it('is deterministic and a 64-char lowercase hex digest', () => {
    const a = computeAgreementSha256(rendered);
    expect(a).toBe(computeAgreementSha256(rendered));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of the key order of vars', () => {
    const reordered: AgreementHashInput = {
      ...rendered,
      vars: { 'dates.effective': 'Oct 01, 2026', 'seller.name': 'MSP LLC', 'client.name': 'Acme Co' },
    };
    expect(computeAgreementSha256(reordered)).toBe(computeAgreementSha256(rendered));
  });

  it('binds every rendered input: a var value, the locale and the effective date each change the hash', () => {
    const base = computeAgreementSha256(rendered);
    expect(computeAgreementSha256({ ...rendered, vars: { ...rendered.vars, 'client.name': 'Acme Corp' } })).not.toBe(base);
    expect(computeAgreementSha256({ ...rendered, renderLocale: 'fr-FR' })).not.toBe(base);
    expect(computeAgreementSha256({ ...rendered, effectiveDate: '2026-10-02' })).not.toBe(base);
    expect(computeAgreementSha256({ ...rendered, versionSha: 'c'.repeat(64) })).not.toBe(base);
  });

  it('rendered and external hashes differ for the same versionSha', () => {
    expect(computeAgreementSha256(rendered)).not.toBe(computeAgreementSha256(external));
  });

  it('external binds the bytes and the mime', () => {
    const base = computeAgreementSha256(external);
    expect(computeAgreementSha256({ ...external, bytesSha256: 'd'.repeat(64) })).not.toBe(base);
    expect(computeAgreementSha256({ ...external, mime: 'image/png' })).not.toBe(base);
  });

  // DO NOT regenerate. These vectors pin the version-1 canonical form that
  // contract_documents.content_sha256 (content_hash_version = 1) is computed
  // with for request-sourced agreements; a stored hash must re-verify forever.
  // If this fails, the canonicalisation changed — add a version 2, never edit v1.
  it('matches the pinned version-1 vectors', () => {
    expect(computeAgreementSha256(rendered, 1)).toBe('9729defef53c629c5bb16f59dad37bf76bb520ae6bc36cf1cc754342c7638284');
    expect(computeAgreementSha256(external, 1)).toBe('e0c39923bec15a56613d7b52231f1f50da3803448f7efdb202d1cae6e16421ca');
  });
});
