import { describe, expect, it } from 'vitest';
import { ORG_CASCADE_DELETE_ORDER, __testOnly } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

describe('script proposal cascade registration', () => {
  it('registers both tables in the org cascade order', () => {
    expect(ORG_CASCADE_DELETE_ORDER).toContain('script_proposals');
    expect(ORG_CASCADE_DELETE_ORDER).toContain('script_proposal_reviews');
  });

  it('deletes reviews before proposals — reviews are the FK child', () => {
    // An FK declared without ON DELETE defaults to NO ACTION, so the
    // referencing table must be deleted FIRST or the cascade raises 23503.
    expect(ORG_CASCADE_DELETE_ORDER.indexOf('script_proposal_reviews'))
      .toBeLessThan(ORG_CASCADE_DELETE_ORDER.indexOf('script_proposals'));
  });

  it('keeps the list alphabetised by localeCompare around the new entries', () => {
    const i = ORG_CASCADE_DELETE_ORDER.indexOf('script_proposal_reviews');
    expect(ORG_CASCADE_DELETE_ORDER[i - 1]).toBe('script_executions');
    expect(ORG_CASCADE_DELETE_ORDER[i + 1]).toBe('script_proposals');
    expect(ORG_CASCADE_DELETE_ORDER[i + 2]).toBe('script_tags');
  });

  it('marks reviews as audit-admin required — they are append-only', () => {
    expect(__testOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('script_proposal_reviews')).toBe(true);
    // Proposals are NOT append-only: status transitions and the merge fence
    // mutate them, so they must stay out of this set.
    expect(__testOnly.AUDIT_ADMIN_REQUIRED_TABLES.has('script_proposals')).toBe(false);
  });
});

describe('script proposal export-policy classification', () => {
  it('classifies both new tables', () => {
    expect(CORE_TENANT_EXPORT_POLICY.script_proposals).toBeDefined();
    expect(CORE_TENANT_EXPORT_POLICY.script_proposal_reviews).toBeDefined();
  });

  it('excludes every open container on the new tables', () => {
    const proposals = CORE_TENANT_EXPORT_POLICY.script_proposals!.columns;
    expect(proposals.verification!.decision).toBe('exclude');
    expect(proposals.verification_result!.decision).toBe('exclude');
    expect(CORE_TENANT_EXPORT_POLICY.script_proposal_reviews!.columns.verdict!.decision).toBe('exclude');
  });

  it('includes the review token counters as reviewed sensitive names', () => {
    const reviews = CORE_TENANT_EXPORT_POLICY.script_proposal_reviews!.columns;
    for (const col of ['input_tokens', 'output_tokens'] as const) {
      expect(reviews[col]!.decision).toBe('include');
      expect(reviews[col]!.reviewedSensitiveName).toBe(true);
    }
  });

  it('classifies every new column on the two already-registered tables', () => {
    const execs = CORE_TENANT_EXPORT_POLICY.script_executions!.columns;
    for (const col of [
      'source_kind', 'proposal_id', 'language', 'timeout_seconds', 'content_digest',
      'script_version_id', 'review_id', 'approved_by', 'approval_method',
      'review_risk_tier', 'review_summary',
    ]) {
      expect(execs[col], `script_executions.${col}`).toBeDefined();
    }
    const scriptCols = CORE_TENANT_EXPORT_POLICY.scripts!.columns;
    expect(scriptCols.origin).toBeDefined();
    expect(scriptCols.origin_proposal_id).toBeDefined();
  });
});
