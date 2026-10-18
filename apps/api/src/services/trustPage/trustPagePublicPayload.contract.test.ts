// apps/api/src/services/trustPage/trustPagePublicPayload.contract.test.ts
import { describe, expect, it } from 'vitest';
import {
  trustPagePublicPayloadSchema, TELEMETRY_CONTROL_IDS, TRUST_CONTROL_CATALOG, DEFAULT_TRUST_EVALUATION_POLICY, evaluateTrustControls,
  emptyControlEvidence, resolveFrozenConfig, trustPublishedConfigSchema,
} from '@breeze/shared';
import { buildTrustPagePayload } from './payloadBuilder';

const DENY = [
  'deviceId', 'hostname', 'ipAddress', 'cve', 'topIssues', 'top_issues', 'openPorts', 'score', 'overallScore', 'userPrincipalName',
  'sha256', 'originalFilename', 'storageKey', 'uploadedByUserId', 'weights',
  // W2 (#8770): the access flow and declarations must never leak requester or token material.
  'requesterEmail', 'token', 'tokenHash', 'ndaAccepted', 'ndaTextAccepted', 'declaredByUserId', 'evidenceDocumentSha256',
];

function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  return out;
}

const DOC_ID = '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d';

describe('trust page public payload contract', () => {
  it('builder output (every W2 block filled) validates strictly and contains no denylisted key at any depth, even from a poisoned input', () => {
    const config = {
      ...resolveFrozenConfig(trustPublishedConfigSchema.parse({
        hiddenControlIds: [], showPercentages: true, showDeviceCount: true, showManagedBy: true, searchIndexable: false,
        introHtml: null, websiteUrl: null, securityContactEmail: null, documentIds: [DOC_ID],
        documents: [{ id: DOC_ID, visibility: 'gated' }], ndaText: 'Keep it confidential.', showHistory: true, frameworkView: ['nist_csf_2'],
      })),
      catalogControlIds: [...TELEMETRY_CONTROL_IDS],
      hostname: 'LEAK',
    };
    const poisoned = {
      snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', generatedAt: new Date(), publishedAt: new Date(),
      config: config as never,
      sections: {
        declaredControls: [{ id: 'incident_response_plan', category: 'governance', source: 'declared', status: 'current', statement: 'We keep a plan.', declaredBy: 'MSP', declaredAt: '2026-10-01T00:00:00.000Z', expiresAt: '2027-10-01T00:00:00.000Z', evidenceDocumentId: null, frameworkRefs: [{ framework: 'cis_v8', ref: '17.1' }] }],
        subprocessors: [{ name: 'Vendor', purpose: 'Hosting', location: 'EU', websiteUrl: 'https://vendor.example' }],
        faq: [{ question: 'Q?', answerHtml: '<p>A</p>' }],
        history: [{ at: '2026-10-01T00:00:00.000Z', met: 3, shown: 16 }],
        frameworks: ['nist_csf_2'],
        access: { ndaText: 'Keep it confidential.' },
      } as never,
      org: { name: 'Acme', hostname: 'LEAK' } as never,
      partner: { name: 'MSP', settings: { branding: {}, apiToken: 'LEAK' }, billingWebsite: null, trustPageUnbranded: false },
      orgBrand: null,
      assessments: evaluateTrustControls(TRUST_CONTROL_CATALOG, emptyControlEvidence(), DEFAULT_TRUST_EVALUATION_POLICY, new Date()).map((a) => ({ ...a, deviceId: 'LEAK', topIssues: ['LEAK'] })) as never,
      deviceCount: 3,
      documents: [{ id: DOC_ID, orgId: 'o', title: 'Doc', description: null, category: 'policy', contentType: 'application/pdf', byteSize: 1, sha256: 'LEAK'.repeat(16), originalFilename: 'LEAK.pdf', uploadedByUserId: 'LEAK', portalVisible: false, supersedesDocumentId: null, supersededByDocumentId: null, createdAt: new Date().toISOString(), visibility: 'public', requesterEmail: 'LEAK' }] as never,
      policy: { evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 } },
    };
    const payload = buildTrustPagePayload(poisoned);
    expect(trustPagePublicPayloadSchema.safeParse(payload).success).toBe(true);
    // Every W2 block is actually present, so the denylist ran over them.
    expect(payload.documents[0]?.visibility).toBe('gated');
    expect(payload.declaredControls).toHaveLength(1);
    expect(payload.subprocessors).toHaveLength(1);
    expect(payload.faq).toHaveLength(1);
    expect(payload.history).toHaveLength(1);
    expect(payload.access).toEqual({ ndaText: 'Keep it confidential.' });
    const keys = keysDeep(payload);
    for (const k of DENY) expect(keys.has(k), k).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('LEAK');
  });

  it('hardening safeguards carry identifiers and counts only — never a check id, title or finding (CIS licensing, spec §18.13)', () => {
    const prevFlag = process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW;
    process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = 'true';
    try {
      const fresh = '2026-10-13T11:00:00.000Z';
      const evidence = emptyControlEvidence();
      evidence.hardening_baseline = {
        eligible: 12, assessed: 12, passing: 12, aggregatePct: 99, newestEvidenceAt: fresh,
        safeguards: { '4.5': { eligible: 12, assessed: 12, passing: 12, newestEvidenceAt: fresh }, '4.7': { eligible: 12, assessed: 12, passing: 11, newestEvidenceAt: fresh } },
      };
      // A fixture whose assessment carries the agent's verbatim titles, which the builder must never forward.
      const assessments = evaluateTrustControls(TRUST_CONTROL_CATALOG, evidence, DEFAULT_TRUST_EVALUATION_POLICY, new Date('2026-10-13T12:00:00.000Z')).map((a) => (
        a.id === 'hardening_baseline'
          ? { ...a, findings: [{ checkId: '9.1.1', title: 'Ensure Windows Firewall is enabled for all profiles', status: 'pass' }], checkId: '9.1.1', title: "Ensure 'Accounts: Guest account status' is set to 'Disabled'" }
          : a
      )) as never;
      const config = {
        ...resolveFrozenConfig(trustPublishedConfigSchema.parse({
          hiddenControlIds: [], showPercentages: true, showDeviceCount: false, showManagedBy: true, searchIndexable: false,
          introHtml: null, websiteUrl: null, securityContactEmail: null, documentIds: [],
        })),
        catalogControlIds: [...TELEMETRY_CONTROL_IDS],
      };
      const payload = buildTrustPagePayload({
        snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', generatedAt: new Date(), publishedAt: new Date(), config,
        sections: { declaredControls: [], subprocessors: [], faq: [], history: [], frameworks: [], access: null },
        org: { name: 'Acme' }, partner: { name: 'MSP', settings: {}, billingWebsite: null, trustPageUnbranded: false }, orgBrand: null,
        assessments, deviceCount: 12, documents: [],
        policy: { evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 } },
      });
      expect(payload.controls.find((c) => c.id === 'hardening_baseline')?.safeguards).toHaveLength(2); // the denylist ran over real safeguards
      const keys = keysDeep(payload);
      for (const k of ['checkId', 'title', 'findings']) expect(keys.has(k), k).toBe(false);
      const json = JSON.stringify(payload);
      expect(json).not.toContain('Ensure ');
      expect(json).not.toContain('9.1.1');
      expect(trustPagePublicPayloadSchema.safeParse(payload).success).toBe(true);
    } finally {
      if (prevFlag === undefined) delete process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW; else process.env.BREEZE_TRUST_CIS_FRAMEWORK_VIEW = prevFlag;
    }
  });
});
