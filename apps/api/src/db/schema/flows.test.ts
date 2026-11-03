import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { flows } from './flows';
import { ORG_CASCADE_DELETE_ORDER } from '../../services/tenantCascade';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';

// Tool Catalog W03 (#5218) — the `flows` table. The org-cascade / export /
// merge contracts fail only under Integration Tests; these unit guards make a
// missed registration red in Test API too.
const COLUMNS = [
  'id', 'orgId', 'partnerId', 'slug', 'name', 'description', 'definition',
  'definitionVersion', 'effectiveTier', 'status', 'pausedReason',
  'enabledByUserId', 'enabledAt', 'createdByUserId', 'aiSessionId',
  'managedByAgentId', 'createdAt', 'updatedAt',
  // W04 (#5219): live publication pointer + schedule occurrence key.
  'enabledPublicationSeq', 'scheduleLastOccurrenceKey',
  // W05 (#5220, 2027-01-07-140000-flow-webhooks-tools-budgets.sql): the
  // per-flow webhook secret (ciphertext + display fingerprint + rotation
  // stamp), the last unauthenticated delivery, and the last admission refusal.
  'webhookSecretEncrypted', 'webhookSecretFingerprint', 'webhookSecretRotatedAt',
  'webhookLastAuthFailureAt', 'webhookLastAuthFailureReason',
  'lastAdmissionRefusalAt', 'lastAdmissionRefusalCode',
] as const;

describe('flows schema', () => {
  it('declares the W3 + W4 + W5 columns, with the webhook secret as W05 shipped it (Decision 4)', () => {
    expect(getTableName(flows)).toBe('flows');
    const cols = Object.keys(getTableColumns(flows));
    expect(cols.sort()).toEqual([...COLUMNS].sort());
    // Decision 4: an encrypted secret, never a stored token fingerprint used as a verifier.
    expect(cols).not.toContain('webhookTokenFingerprint');
  });

  it('keeps the W05 webhook secret out of tenant export (excludedSensitive), the fingerprint reviewed', () => {
    const policy = CORE_TENANT_EXPORT_POLICY.flows!;
    expect(policy.columns.webhook_secret_encrypted!.decision).toBe('exclude');
    expect(policy.columns.webhook_secret_encrypted!.rationale).toMatch(/credential/);
    expect(policy.columns.webhook_secret_fingerprint!.decision).toBe('include');
    expect(policy.columns.webhook_secret_fingerprint!.reviewedSensitiveName).toBe(true);
  });

  it('is registered in the org cascade, export policy and org merge registries', () => {
    expect(ORG_CASCADE_DELETE_ORDER).toContain('flows');
    const policy = CORE_TENANT_EXPORT_POLICY.flows;
    expect(policy).toBeDefined();
    const sqlNames = Object.values(getTableColumns(flows)).map((c) => c.name).sort();
    expect(Object.keys(policy!.columns).sort()).toEqual(sqlNames);
    // jsonb is always excludedOpen.
    expect(policy!.columns.definition!.decision).not.toBe('include');
    expect(getOrgMergePolicies().get('flows')).toEqual(expect.objectContaining({ kind: 'custom' }));
  });
});
