// apps/api/src/services/trustPage/trustPagePublicPayload.contract.test.ts
import { describe, expect, it } from 'vitest';
import { trustPagePublicPayloadSchema, TRUST_CONTROL_CATALOG, DEFAULT_TRUST_EVALUATION_POLICY, evaluateTrustControls, emptyControlEvidence } from '@breeze/shared';
import { buildTrustPagePayload } from './payloadBuilder';

const DENY = ['deviceId', 'hostname', 'ipAddress', 'cve', 'topIssues', 'top_issues', 'openPorts', 'score', 'overallScore', 'userPrincipalName', 'sha256', 'originalFilename', 'storageKey', 'uploadedByUserId', 'weights'];

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

describe('trust page public payload contract', () => {
  it('builder output validates strictly and contains no denylisted key at any depth, even from a poisoned input', () => {
    const poisoned = {
      snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', generatedAt: new Date(), publishedAt: new Date(),
      page: { id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6b', orgId: 'o', partnerId: 'p', isPartnerHome: false, publishedAt: new Date(), publicationRevision: 1,
        searchIndexable: false, showPercentages: true, showDeviceCount: true, showManagedBy: true, securityContactEmail: null, websiteUrl: null, introHtml: null,
        hiddenControlIds: [], publicationAuthorizedBy: null, publicationAuthorizedAt: null, publicationAuthorizedByUserId: null, lastEvaluatedAt: null,
        createdByUserId: null, updatedByUserId: null, createdAt: new Date(), updatedAt: new Date(),
        hostname: 'LEAK', ipAddress: '10.0.0.1' } as never,
      org: { name: 'Acme', hostname: 'LEAK' } as never,
      partner: { name: 'MSP', settings: { branding: {}, apiToken: 'LEAK' }, billingWebsite: null, trustPageUnbranded: false },
      orgBrand: null,
      assessments: evaluateTrustControls(TRUST_CONTROL_CATALOG, emptyControlEvidence(), DEFAULT_TRUST_EVALUATION_POLICY, new Date()).map((a) => ({ ...a, deviceId: 'LEAK', topIssues: ['LEAK'] })) as never,
      deviceCount: 3,
      documents: [{ id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d', orgId: 'o', title: 'Doc', description: null, category: 'policy', contentType: 'application/pdf', byteSize: 1, sha256: 'LEAK'.repeat(16), originalFilename: 'LEAK.pdf', uploadedByUserId: 'LEAK', portalVisible: false, supersedesDocumentId: null, supersededByDocumentId: null, createdAt: new Date().toISOString() }] as never,
      policy: { evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 } },
    };
    const payload = buildTrustPagePayload(poisoned);
    expect(trustPagePublicPayloadSchema.safeParse(payload).success).toBe(true);
    const keys = keysDeep(payload);
    for (const k of DENY) expect(keys.has(k), k).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('LEAK');
  });
});
