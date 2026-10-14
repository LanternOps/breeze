import { createHash } from 'node:crypto';
import {
  FRAMEWORK_META, TRUST_CONTROL_CATALOG, TRUST_CONTROL_CATALOG_VERSION, TRUST_FRAMEWORKS,
  trustPagePublicPayloadSchema, type TrustControlAssessment, type TrustFramework, type TrustPagePublicPayload,
} from '@breeze/shared';
import type { TrustPageRow } from '../../db/schema/trustPages';
import { resolveDocumentBrand } from '../partnerDocumentBrand';
import { sanitizeFlowRichTextHtml } from '../richTextSanitize';
import type { OrgDocumentView } from '../orgDocumentService';

export const TRUST_ELIGIBILITY_NOTE =
  'Eligible devices are Breeze-managed, non-ephemeral, non-decommissioned devices in this organization. A device counts as assessed only when Breeze holds evidence for the control inside the evidence window.';

export interface BuildPayloadInput {
  snapshotId: string; generatedAt: Date; publishedAt: Date;
  page: TrustPageRow;
  org: { name: string };
  partner: { name: string; settings: unknown; billingWebsite: string | null; trustPageUnbranded: boolean };
  orgBrand: { logoUrl: string | null; primaryColor: string | null } | null;
  assessments: TrustControlAssessment[];
  deviceCount: number;
  documents: OrgDocumentView[];
  policy: { evidenceMaxAgeDays: number; definitionsMaxAgeDays: number; coverageFloorPct: number; thresholds: { met: number; attention: number } };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const https = (v: string | null | undefined): string | null => (v && /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(v.trim()) ? v.trim() : null);
const logo = (v: string | null | undefined): string | null =>
  v && v.length <= 150_000 && (v.startsWith('https://') || v.startsWith('data:image/')) ? v : null;
const hex = (v: string | null | undefined): string | null => (v && HEX.test(v.trim()) ? v.trim().toLowerCase() : null);

export function sanitizeIntro(html: string | null | undefined): string | null {
  if (!html) return null;
  const out = sanitizeFlowRichTextHtml(html).trim();
  return out.length === 0 || out === '<p></p>' ? null : out;
}

export function buildTrustPagePayload(input: BuildPayloadInput): TrustPagePublicPayload {
  const { page } = input;
  const hidden = new Set(page.hiddenControlIds);
  const shown = input.assessments.filter((a) => !hidden.has(a.id));
  const brand = resolveDocumentBrand(input.orgBrand ?? undefined, input.partner.settings);
  const partnerBrand = resolveDocumentBrand(undefined, input.partner.settings);
  const attributions = TRUST_FRAMEWORKS.filter((fw: TrustFramework) => shown.some((a) => a.frameworkRefs.some((r) => r.framework === fw)));
  const deviceCount = page.showDeviceCount && input.deviceCount > 0 ? input.deviceCount : null;

  const payload: TrustPagePublicPayload = {
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    generatedAt: input.generatedAt.toISOString(),
    publishedAt: input.publishedAt.toISOString(),
    org: {
      name: input.org.name,
      // Org row wins field by field; an unusable org value (http:, non-hex) falls back to the partner's.
      logoUrl: logo(brand.logoUrl) ?? logo(partnerBrand.logoUrl),
      primaryColor: hex(brand.primaryColor) ?? hex(partnerBrand.primaryColor),
      websiteUrl: https(page.websiteUrl),
      securityContactEmail: page.securityContactEmail?.trim() || null,
    },
    managedBy: page.showManagedBy
      ? { name: input.partner.name, logoUrl: logo(partnerBrand.logoUrl), websiteUrl: https(input.partner.billingWebsite) }
      : null,
    introHtml: sanitizeIntro(page.introHtml),
    summary: {
      catalogTotal: TRUST_CONTROL_CATALOG.length,
      controlsShown: shown.length,
      controlsMet: shown.filter((a) => a.status === 'met').length,
      deviceCount,
    },
    methodology: {
      catalogVersion: TRUST_CONTROL_CATALOG_VERSION,
      evidenceMaxAgeDays: input.policy.evidenceMaxAgeDays,
      definitionsMaxAgeDays: input.policy.definitionsMaxAgeDays,
      coverageFloorPct: input.policy.coverageFloorPct,
      thresholds: { ...input.policy.thresholds },
      eligibilityNote: TRUST_ELIGIBILITY_NOTE,
    },
    controls: shown.map((a) => ({
      id: a.id, category: a.category, source: 'telemetry', unit: a.unit,
      status: a.status, reason: a.reason,
      percent: page.showPercentages && a.status !== 'not_assessed' ? a.percent : null,
      assessed: page.showPercentages && a.status !== 'not_assessed' ? a.assessed : null,
      eligible: page.showPercentages && a.status !== 'not_assessed' ? a.eligible : null,
      evidenceAsOf: a.evidenceAsOf,
      frameworkRefs: a.frameworkRefs.map((r) => ({ framework: r.framework, ref: r.ref })),
    })),
    documents: input.documents.slice(0, 20).map((d) => ({
      id: d.id, title: d.title, category: d.category, contentType: d.contentType, byteSize: d.byteSize,
      updatedAt: d.createdAt, visibility: 'public' as const,
    })),
    footer: { poweredByBreeze: !input.partner.trustPageUnbranded, frameworkAttributions: attributions },
  };
  // The schema is the exposure boundary: anything the projection above missed fails here, loudly.
  return trustPagePublicPayloadSchema.parse(payload);
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}
export function payloadSha256(payload: TrustPagePublicPayload): string {
  // snapshotId/generatedAt change every build; exclude them so identical evidence dedupes (spec §7 "Refresh").
  const { snapshotId: _s, generatedAt: _g, ...rest } = payload;
  return createHash('sha256').update(JSON.stringify(stable(rest))).digest('hex');
}
export { FRAMEWORK_META };
