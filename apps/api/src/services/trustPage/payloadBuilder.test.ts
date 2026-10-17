// apps/api/src/services/trustPage/payloadBuilder.test.ts
import { describe, expect, it } from 'vitest';
import { TRUST_CONTROL_CATALOG, DEFAULT_TRUST_EVALUATION_POLICY, evaluateTrustControls, emptyControlEvidence } from '@breeze/shared';
import { buildTrustPagePayload, payloadSha256, sanitizeIntro, type BuildPayloadInput } from './payloadBuilder';

const AS_OF = new Date('2026-10-13T12:00:00.000Z');
function page(over: Partial<BuildPayloadInput['page']> = {}): BuildPayloadInput['page'] {
  return {
    id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6b', orgId: 'o1', partnerId: 'p1', isPartnerHome: false,
    publishedAt: new Date('2026-10-01T09:00:00.000Z'), publicationRevision: 2, searchIndexable: false,
    showPercentages: false, showDeviceCount: false, showManagedBy: true,
    securityContactEmail: 'security@acme.example', websiteUrl: 'https://acme.example',
    introHtml: '<p>Hi</p>', hiddenControlIds: [],
    publicationAuthorizedBy: 'Jane Doe, COO', publicationAuthorizedAt: AS_OF, publicationAuthorizedByUserId: null,
    lastEvaluatedAt: AS_OF, publishedConfig: null, createdByUserId: null, updatedByUserId: null, createdAt: AS_OF, updatedAt: AS_OF,
    ...over,
  } as BuildPayloadInput['page'];
}
function input(over: Partial<BuildPayloadInput> = {}): BuildPayloadInput {
  const ev = emptyControlEvidence();
  ev.disk_encryption = { eligible: 50, assessed: 46, passing: 45, aggregatePct: null, newestEvidenceAt: '2026-10-13T11:00:00.000Z' };
  return {
    snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6c', generatedAt: AS_OF, publishedAt: new Date('2026-10-01T09:00:00.000Z'),
    page: page(), org: { name: 'Acme Dental' },
    partner: { name: 'Northwind IT', settings: { branding: { logoUrl: 'https://cdn.example/nw.png', primaryColor: '#123456' } }, billingWebsite: 'https://northwind.example', trustPageUnbranded: false },
    orgBrand: null,
    assessments: evaluateTrustControls(TRUST_CONTROL_CATALOG, ev, DEFAULT_TRUST_EVALUATION_POLICY, AS_OF),
    deviceCount: 50,
    documents: [],
    policy: { evidenceMaxAgeDays: 30, definitionsMaxAgeDays: 7, coverageFloorPct: 80, thresholds: { met: 95, attention: 80 } },
    ...over,
  };
}

describe('buildTrustPagePayload', () => {
  it('produces a schema-valid payload with status-only controls by default', () => {
    const p = buildTrustPagePayload(input());
    expect(p.schemaVersion).toBe(1);
    const enc = p.controls.find((c) => c.id === 'disk_encryption')!;
    expect(enc).toMatchObject({ status: 'met', percent: null, assessed: null, eligible: null });
    expect(p.summary).toEqual({ catalogTotal: 15, controlsShown: 15, controlsMet: 1, deviceCount: null });
    expect(p.footer).toEqual({ poweredByBreeze: true, frameworkAttributions: ['cis_v8', 'essential_eight', 'cyber_essentials', 'nist_csf_2'] });
  });
  it('opt-ins expose percent/assessed/eligible and device count', () => {
    const p = buildTrustPagePayload(input({ page: page({ showPercentages: true, showDeviceCount: true }) }));
    expect(p.controls.find((c) => c.id === 'disk_encryption')).toMatchObject({ percent: 98, assessed: 46, eligible: 50 });
    expect(p.summary.deviceCount).toBe(50);
  });
  it('hidden controls are omitted but catalogTotal stays 15; attributions follow shown controls only', () => {
    const hidden = TRUST_CONTROL_CATALOG.filter((c) => c.id !== 'disk_encryption').map((c) => c.id);
    const p = buildTrustPagePayload(input({ page: page({ hiddenControlIds: hidden }) }));
    expect(p.controls.map((c) => c.id)).toEqual(['disk_encryption']);
    expect(p.summary).toMatchObject({ catalogTotal: 15, controlsShown: 1 });
    expect(p.footer.frameworkAttributions).toEqual(['cis_v8', 'nist_csf_2']);
  });
  it('branding: org logo wins, partner fills gaps; managedBy honours the toggle; unbranded removes the footer flag', () => {
    const p = buildTrustPagePayload(input({ orgBrand: { logoUrl: 'https://cdn.example/acme.png', primaryColor: null } }));
    expect(p.org).toMatchObject({ logoUrl: 'https://cdn.example/acme.png', primaryColor: '#123456' });
    expect(p.managedBy).toEqual({ name: 'Northwind IT', logoUrl: 'https://cdn.example/nw.png', websiteUrl: 'https://northwind.example' });
    const q = buildTrustPagePayload(input({ page: page({ showManagedBy: false }), partner: { ...input().partner, trustPageUnbranded: true } }));
    expect(q.managedBy).toBeNull();
    expect(q.footer.poweredByBreeze).toBe(false);
  });
  it('an http: org logo or non-hex colour falls back to the partner brand; an http: website is dropped', () => {
    const p = buildTrustPagePayload(input({ orgBrand: { logoUrl: 'http://cdn.example/x.png', primaryColor: 'red' }, page: page({ websiteUrl: 'http://acme.example' }) }));
    expect(p.org.logoUrl).toBe('https://cdn.example/nw.png');
    expect(p.org.primaryColor).toBe('#123456');
    expect(p.org.websiteUrl).toBeNull();
    const q = buildTrustPagePayload(input({ orgBrand: { logoUrl: 'http://x', primaryColor: null }, partner: { ...input().partner, settings: {} } }));
    expect(q.org.logoUrl).toBeNull();
  });
  it('zero devices: every device control not_assessed, org controls still evaluated, deviceCount null even when opted in', () => {
    const p = buildTrustPagePayload(input({ deviceCount: 0, page: page({ showDeviceCount: true }), assessments: evaluateTrustControls(TRUST_CONTROL_CATALOG, emptyControlEvidence(), DEFAULT_TRUST_EVALUATION_POLICY, AS_OF) }));
    expect(p.controls.every((c) => c.status === 'not_assessed')).toBe(true);
    expect(p.summary.deviceCount).toBeNull();
  });
  it('documents are projected to the public subset in sort order', () => {
    const doc = { id: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a6d', orgId: 'o1', title: 'Security policy', description: 'x', category: 'policy', contentType: 'application/pdf', byteSize: 1234, sha256: 'a'.repeat(64), originalFilename: 'policy.pdf', uploadedByUserId: 'u1', portalVisible: true, supersedesDocumentId: null, supersededByDocumentId: null, createdAt: '2026-09-01T00:00:00.000Z' } as const;
    const p = buildTrustPagePayload(input({ documents: [doc] }));
    expect(p.documents).toEqual([{ id: doc.id, title: 'Security policy', category: 'policy', contentType: 'application/pdf', byteSize: 1234, updatedAt: '2026-09-01T00:00:00.000Z', visibility: 'public' }]);
    expect(JSON.stringify(p)).not.toContain('a'.repeat(64));
    expect(JSON.stringify(p)).not.toContain('policy.pdf');
  });
  it('sha256 is stable across key order and changes with content', () => {
    const a = buildTrustPagePayload(input());
    const b = JSON.parse(JSON.stringify(a));
    expect(payloadSha256(a)).toBe(payloadSha256(b));
    expect(payloadSha256({ ...a, introHtml: '<p>Changed</p>' })).not.toBe(payloadSha256(a));
  });
  it('sha256 ignores control evidenceAsOf (moves with every check-in) but not a control status change', () => {
    const base = input().assessments;
    const target = base.find((x) => x.id === 'disk_encryption')!;
    expect(target.status).toBe('met');
    const moved = base.map((x) => ({ ...x, evidenceAsOf: x.id === 'disk_encryption' ? '2026-10-13T11:59:00.000Z' : '2026-10-13T11:30:00.000Z' }));
    const a = buildTrustPagePayload(input());
    const b = buildTrustPagePayload(input({ assessments: moved }));
    expect(b.controls.find((c) => c.id === 'disk_encryption')!.evidenceAsOf).not.toBe(a.controls.find((c) => c.id === 'disk_encryption')!.evidenceAsOf);
    expect(payloadSha256(b)).toBe(payloadSha256(a));
    const flipped = base.map((x) => (x.id === 'disk_encryption' ? { ...x, status: 'not_met' as const } : x));
    expect(payloadSha256(buildTrustPagePayload(input({ assessments: flipped })))).not.toBe(payloadSha256(a));
  });
});

describe('builder robustness', () => {
  it('a max-length entity-heavy intro builds (sanitized expansion stays inside the payload bound)', () => {
    const p = buildTrustPagePayload(input({ page: page({ introHtml: '&'.repeat(5000) }) }));
    expect(p.introHtml).not.toBeNull();
    expect(p.introHtml!.length).toBeLessThanOrEqual(40_000);
  });
  it('an intro that expands past the bound is omitted, not thrown', () => {
    const p = buildTrustPagePayload(input({ page: page({ introHtml: '&'.repeat(20_000) }) }));
    expect(p.introHtml).toBeNull();
  });
  it('I13: a hostile page.introHtml (stored before any sanitizer change) is sanitized on the snapshot path; the PARSED payload carries none of it', () => {
    const hostile = '<p onclick="steal()">Welcome <a href="javascript:alert(1)" onmouseover="x()">link</a></p><img src=x onerror=alert(1)><script>alert(1)</script><iframe src="https://evil.example"></iframe>';
    const p = buildTrustPagePayload(input({ page: page({ introHtml: hostile }) }));
    expect(p.introHtml).toContain('Welcome');
    for (const bad of ['onclick', 'onerror', 'onmouseover', '<script', 'javascript:', '<img', '<iframe', 'alert(1)']) {
      expect(p.introHtml ?? '').not.toContain(bad);
    }
  });
  it('an over-long websiteUrl is dropped, not thrown', () => {
    const p = buildTrustPagePayload(input({ page: page({ websiteUrl: 'https://a.example/' + 'x'.repeat(3000) }) }));
    expect(p.org.websiteUrl).toBeNull();
  });
  it('hash ignores snapshotId/generatedAt and key order', () => {
    const a = buildTrustPagePayload(input());
    const b = buildTrustPagePayload(input({ snapshotId: '0f7f0d0e-5a1e-4d4b-9a7b-1c2d3e4f5a99', generatedAt: new Date('2026-10-14T00:00:00.000Z') }));
    expect(payloadSha256(a)).toBe(payloadSha256(b));
    const rev = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).reverse()) as T;
    const c = { ...JSON.parse(JSON.stringify(a)), org: rev(a.org), summary: rev(a.summary) };
    expect(payloadSha256(c)).toBe(payloadSha256(a));
  });
});

describe('sanitizeIntro', () => {
  it.each(['<p><br></p>', '<p>&nbsp;</p>', '<p> </p>'])('visually empty %s -> null', (h) => {
    expect(sanitizeIntro(h)).toBeNull();
  });
  it('strips scripts, javascript: links, tables and inline styles; keeps the flow subset', () => {
    const out = sanitizeIntro('<p style="color:red">Hi <a href="javascript:alert(1)">x</a> <a href="https://ok.example">ok</a></p><script>1</script><table><tr><td>t</td></tr></table><h3>H</h3>');
    expect(out).not.toMatch(/script|javascript:|style=|<table|<td/);
    expect(out).toContain('<h3>H</h3>');
    expect(out).toContain('href="https://ok.example"');
  });
  it('returns null for empty/whitespace input', () => {
    expect(sanitizeIntro('   ')).toBeNull();
    expect(sanitizeIntro(null)).toBeNull();
  });
});
