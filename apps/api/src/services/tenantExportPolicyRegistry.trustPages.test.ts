import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  trustPages, trustPageSnapshots, trustPageDocuments, trustPageDeclarations, trustPageAccessRequests,
  trustPageAccessTokens, trustPageFaqItems, trustPageSubprocessors,
} from '../db/schema/trustPages';
import { getTenantExportPolicyRegistry } from './tenantExportPolicyRegistry';

/**
 * Trust Center W1: trust_pages, trust_page_snapshots and trust_page_documents
 * are org-cascade tables, so `tenant-export-policy.integration.test.ts`
 * classifies every column — but that suite needs a live database, so a missed
 * classification only reds in Integration Tests. Pinning it here moves the
 * failure into Test API (same reasoning as the portal_branding.chrome_accent
 * test in tenantExportPolicyRegistry.portalBranding.test.ts).
 */
const TABLES: ReadonlyArray<[string, PgTable]> = [
  ['trust_pages', trustPages],
  ['trust_page_snapshots', trustPageSnapshots],
  ['trust_page_documents', trustPageDocuments],
  // Trust Center W2 (#8770 W02a)
  ['trust_page_declarations', trustPageDeclarations],
  ['trust_page_access_requests', trustPageAccessRequests],
  ['trust_page_access_tokens', trustPageAccessTokens],
  ['trust_page_faq_items', trustPageFaqItems],
  ['trust_page_subprocessors', trustPageSubprocessors],
];

function dbColumnNames(table: PgTable): string[] {
  return Object.values(getTableColumns(table) as Record<string, { name: string }>)
    .map((c) => c.name)
    .sort();
}

describe('trust center export policy', () => {
  it.each(TABLES)('%s is registered, keyed on org_id, and classifies exactly its schema columns', (name, table) => {
    const policy = getTenantExportPolicyRegistry()[name];
    expect(policy).toBeDefined();
    expect(policy!.organizationKey).toBe('org_id');
    expect(Object.keys(policy!.columns).sort()).toEqual(dbColumnNames(table));
  });

  it('excludes the jsonb snapshot payload as an open container', () => {
    const payload = getTenantExportPolicyRegistry()['trust_page_snapshots']?.columns['payload'];
    expect(payload?.decision).toBe('exclude');
    expect(payload?.openContainerReviewed).toBe(true);
  });

  it('excludes the jsonb frozen publication config as an open container', () => {
    const cfg = getTenantExportPolicyRegistry()['trust_pages']?.columns['published_config'];
    expect(cfg?.decision).toBe('exclude');
    expect(cfg?.openContainerReviewed).toBe(true);
  });

  it('includes payload_sha256 as a reviewed integrity digest', () => {
    const digest = getTenantExportPolicyRegistry()['trust_page_snapshots']?.columns['payload_sha256'];
    expect(digest?.decision).toBe('include');
    expect(digest?.reviewedSensitiveName).toBe(true);
  });

  it('excludes the access-token hash as sensitive verifier material', () => {
    const hash = getTenantExportPolicyRegistry()['trust_page_access_tokens']?.columns['token_hash'];
    expect(hash?.decision).toBe('exclude');
    // excludedSensitive (verifier), not excludedOpen (container): both exclude, only the rationale differs.
    expect(hash?.rationale).toMatch(/verifier/);
  });

  it.each([
    ['trust_page_access_requests', 'nda_text_sha256'],
    ['trust_page_declarations', 'evidence_document_sha256'],
  ])('%s.%s is a reviewed, included content digest', (table, column) => {
    const digest = getTenantExportPolicyRegistry()[table]?.columns[column];
    expect(digest?.decision).toBe('include');
    expect(digest?.reviewedSensitiveName).toBe(true);
  });

  it('includes the W2 trust_pages settings columns', () => {
    const cols = getTenantExportPolicyRegistry()['trust_pages']!.columns;
    for (const c of ['framework_view', 'show_history', 'nda_text', 'access_request_creates_ticket']) {
      expect(cols[c]?.decision, c).toBe('include');
    }
  });
});
