import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { formatAuditResourceType } from './auditResourceType';

// That every type the API can write has a label here is checked in test-api
// (apps/api/src/services/auditResourceTypeLabels.test.ts), which reads the API
// source; test-web is not gated on API changes.

function englishCatalog(): Record<string, string> {
  const admin = JSON.parse(readFileSync(resolve(__dirname, '../locales/en/admin.json'), 'utf8'));
  return admin.audit.resourceTypes as Record<string, string>;
}

describe('audit resource type labels (#9856)', () => {
  it('never labels a type with its raw token', () => {
    const raw = Object.entries(englishCatalog()).filter(([type, label]) => label === type || /_/.test(label));
    expect(raw).toEqual([]);
  });

  it('formats a known type from the catalog, an unknown type readably, and nothing as "-"', () => {
    const labels = { saved_filter: 'Saved view' };
    expect(formatAuditResourceType('saved_filter', labels)).toBe('Saved view');
    // Path-derived types from the catch-all audit middleware are open-ended.
    expect(formatAuditResourceType('ai-risk', labels)).toBe('AI risk');
    expect(formatAuditResourceType('patch_compliance_report')).toBe('Patch compliance report');
    // Not an inherited Object.prototype member.
    expect(formatAuditResourceType('constructor', labels)).toBe('Constructor');
    expect(formatAuditResourceType('')).toBe('-');
    expect(formatAuditResourceType(undefined)).toBe('-');
  });
});
