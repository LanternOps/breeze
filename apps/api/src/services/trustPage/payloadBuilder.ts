import { createHash } from 'node:crypto';
import {
  FRAMEWORK_META, TRUST_CONTROL_CATALOG_VERSION, TRUST_DOCUMENTS_MAX, TRUST_FRAMEWORKS, TRUST_INTRO_STORED_MAX_CHARS,
  trustPagePublicPayloadSchema, type TrustControlAssessment, type TrustDocumentVisibility, type TrustFramework,
  type TrustPagePublicPayload, type TrustPublishedConfigResolved,
} from '@breeze/shared';
import { resolveDocumentBrand } from '../partnerDocumentBrand';
import { sanitizeFlowRichTextHtml } from '../richTextSanitize';
import type { OrgDocumentView } from '../orgDocumentService';
import type { SectionBlocks } from './sections/types';

export const TRUST_ELIGIBILITY_NOTE =
  'Eligible devices are Breeze-managed, non-ephemeral, non-decommissioned devices in this organization. A device counts as assessed only when Breeze holds evidence for the control inside the evidence window.';

export interface LiveTrustDocument extends OrgDocumentView {
  /** The LIVE link's visibility (trust_page_documents.visibility). */
  visibility: TrustDocumentVisibility;
}

export interface BuildPayloadInput {
  snapshotId: string; generatedAt: Date; publishedAt: Date;
  /** Draft (publish/preview) or frozen (refresh) publication config, every W2 field resolved. */
  config: TrustPublishedConfigResolved;
  /** The W2 blocks from the section modules (sections/index.ts buildSections). */
  sections: SectionBlocks;
  org: { name: string };
  partner: { name: string; settings: unknown; billingWebsite: string | null; trustPageUnbranded: boolean };
  orgBrand: { logoUrl: string | null; primaryColor: string | null } | null;
  assessments: TrustControlAssessment[];
  deviceCount: number;
  /** Every live (confirmed, not deleted, not superseded) linked document, both visibilities. */
  documents: LiveTrustDocument[];
  policy: { evidenceMaxAgeDays: number; definitionsMaxAgeDays: number; coverageFloorPct: number; thresholds: { met: number; attention: number } };
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const https = (v: string | null | undefined): string | null => (v && v.trim().length <= 2048 && /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(v.trim()) ? v.trim() : null);
const logo = (v: string | null | undefined): string | null =>
  v && v.length <= 150_000 && (v.startsWith('https://') || v.startsWith('data:image/')) ? v : null;
const hex = (v: string | null | undefined): string | null => (v && HEX.test(v.trim()) ? v.trim().toLowerCase() : null);

export function sanitizeIntro(html: string | null | undefined): string | null {
  if (!html) return null;
  const out = sanitizeFlowRichTextHtml(html).trim();
  const text = out.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
  if (text.length === 0) return null;
  // Sanitized HTML can expand (entities, anchor attributes); never let a publisher-controlled intro throw the builder.
  if (out.length > TRUST_INTRO_STORED_MAX_CHARS) {
    console.warn('[trustPage] intro exceeded payload bound after sanitization; omitted');
    return null;
  }
  return out;
}

/**
 * The payload's document list: the frozen entries, in frozen order, that still have a live link. Visibility is
 * the more restrictive of the frozen and the live value (Review Focus 2): a draft gated→public edit stays gated
 * until a republish; a public→gated edit gates at once.
 */
export function projectPayloadDocuments(
  frozen: TrustPublishedConfigResolved['documents'],
  live: readonly LiveTrustDocument[],
): TrustPagePublicPayload['documents'] {
  const byId = new Map(live.map((d) => [d.id, d]));
  const out: TrustPagePublicPayload['documents'] = [];
  for (const entry of frozen) {
    const d = byId.get(entry.id);
    if (!d) continue;
    out.push({
      id: d.id, title: d.title, category: d.category, contentType: d.contentType, byteSize: d.byteSize, updatedAt: d.createdAt,
      visibility: entry.visibility === 'gated' || d.visibility === 'gated' ? 'gated' : 'public',
    });
  }
  return out.slice(0, TRUST_DOCUMENTS_MAX);
}

export function buildTrustPagePayload(input: BuildPayloadInput): TrustPagePublicPayload {
  const { config, sections } = input;
  const catalog = new Set<string>(config.catalogControlIds);
  const hidden = new Set<string>(config.hiddenControlIds);
  const shown = input.assessments.filter((a) => catalog.has(a.id) && !hidden.has(a.id));
  const brand = resolveDocumentBrand(input.orgBrand ?? undefined, input.partner.settings);
  const partnerBrand = resolveDocumentBrand(undefined, input.partner.settings);
  const referenced = (fw: TrustFramework) =>
    shown.some((a) => a.frameworkRefs.some((r) => r.framework === fw))
    || sections.declaredControls.some((d) => d.frameworkRefs.some((r) => r.framework === fw))
    || sections.frameworks.includes(fw);
  const attributions = TRUST_FRAMEWORKS.filter(referenced);
  const deviceCount = config.showDeviceCount && input.deviceCount > 0 ? input.deviceCount : null;

  const payload: TrustPagePublicPayload = {
    schemaVersion: 2,
    locale: config.locale,
    snapshotId: input.snapshotId,
    generatedAt: input.generatedAt.toISOString(),
    publishedAt: input.publishedAt.toISOString(),
    org: {
      name: input.org.name,
      // Org row wins field by field; an unusable org value (http:, non-hex) falls back to the partner's.
      logoUrl: logo(brand.logoUrl) ?? logo(partnerBrand.logoUrl),
      primaryColor: hex(brand.primaryColor) ?? hex(partnerBrand.primaryColor),
      websiteUrl: https(config.websiteUrl),
      securityContactEmail: config.securityContactEmail?.trim() || null,
    },
    managedBy: config.showManagedBy
      ? { name: input.partner.name, logoUrl: logo(partnerBrand.logoUrl), websiteUrl: https(input.partner.billingWebsite) }
      : null,
    introHtml: sanitizeIntro(config.introHtml),
    summary: {
      // The catalog this page was published against (a W1 page keeps its 15), never the live catalog size.
      catalogTotal: config.catalogControlIds.length,
      controlsShown: shown.length,
      // Telemetry only: declared controls never share a count with telemetry controls (amendment 27).
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
      percent: config.showPercentages && a.status !== 'not_assessed' ? a.percent : null,
      assessed: config.showPercentages && a.status !== 'not_assessed' ? a.assessed : null,
      eligible: config.showPercentages && a.status !== 'not_assessed' ? a.eligible : null,
      evidenceAsOf: a.evidenceAsOf,
      frameworkRefs: a.frameworkRefs.map((r) => ({ framework: r.framework, ref: r.ref })),
    })),
    documents: projectPayloadDocuments(config.documents, input.documents),
    declaredControls: sections.declaredControls,
    frameworks: sections.frameworks,
    subprocessors: sections.subprocessors,
    faq: sections.faq,
    history: sections.history,
    access: sections.access,
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
  // Control evidenceAsOf is excluded too: device evidence timestamps move with every check-in, so hashing them
  // would make the hourly refresh insert a snapshot per page per hour. The page-level lastEvaluatedAt (served
  // outside the payload) carries freshness; a status, count or percent change still changes the hash.
  // `history` is excluded (amendment 29): it grows on its own, and the renderer appends the current point.
  const { snapshotId: _s, generatedAt: _g, history: _h, controls, ...rest } = payload;
  const substance = { ...rest, controls: controls.map(({ evidenceAsOf: _e, ...c }) => c) };
  return createHash('sha256').update(JSON.stringify(stable(substance))).digest('hex');
}
export { FRAMEWORK_META };
