// packages/shared/src/validators/trustCenter.ts
import { z } from 'zod';
import { TELEMETRY_CONTROL_IDS, TRUST_CONTROL_CATEGORY_ORDER, TRUST_FRAMEWORKS } from '../trustCenter/types';

export const TRUST_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const trustSlugSchema = z.string().min(1).max(63).regex(TRUST_SLUG_RE);

export const TRUST_INTRO_MAX_CHARS = 5000;
export const TRUST_DOCUMENTS_MAX = 20;
/**
 * Upper bound on a SANITIZED, stored intro: the sanitizer can expand the
 * editor's raw input (entities, anchor attributes) up to ~6x; 8x bounds the
 * worst case. Mirrored by the trust_pages_intro_len_chk CHECK in
 * migrations/2026-12-29-130100-trust-pages.sql — change both together.
 */
export const TRUST_INTRO_STORED_MAX_CHARS = TRUST_INTRO_MAX_CHARS * 8;

const httpsUrl = z.string().trim().max(2048).refine((v) => /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(v), 'https URL required');
const isoDate = z.string().datetime({ offset: true });
const hexColor = z.string().regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
/** https or an inline image data URL, bounded so a logo cannot bloat the payload. */
const logoUrl = z.string().max(150_000).refine((v) => v.startsWith('https://') || v.startsWith('data:image/'), 'https or data:image URL');

export const trustControlStatusSchema = z.enum(['met', 'attention', 'not_met', 'not_assessed']);
export const trustNotAssessedReasonSchema = z.enum(['insufficient_telemetry', 'no_data', 'not_applicable']);
export const trustFrameworkSchema = z.enum(TRUST_FRAMEWORKS);
export const telemetryControlIdSchema = z.enum(TELEMETRY_CONTROL_IDS);

const frameworkRefSchema = z.strictObject({ framework: trustFrameworkSchema, ref: z.string().min(1).max(32) });

export const trustPagePublicControlSchema = z.strictObject({
  id: telemetryControlIdSchema,
  category: z.enum(TRUST_CONTROL_CATEGORY_ORDER),
  source: z.literal('telemetry'),
  unit: z.enum(['devices', 'users', 'org']),
  status: trustControlStatusSchema,
  reason: trustNotAssessedReasonSchema.nullable(),
  percent: z.number().int().min(0).max(100).nullable(),
  assessed: z.number().int().min(0).nullable(),
  eligible: z.number().int().min(0).nullable(),
  evidenceAsOf: isoDate.nullable(),
  frameworkRefs: z.array(frameworkRefSchema).max(12),
}).superRefine((c, ctx) => {
  if (c.status === 'not_assessed' && (c.percent !== null || c.reason === null)) {
    ctx.addIssue({ code: 'custom', message: 'not_assessed carries a reason and no percent' });
  }
  if (c.status !== 'not_assessed' && c.reason !== null) {
    ctx.addIssue({ code: 'custom', message: 'reason only with not_assessed' });
  }
});

export const trustPagePublicDocumentSchema = z.strictObject({
  id: z.string().guid(),
  title: z.string().min(1).max(200),
  category: z.enum(['baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other']),
  contentType: z.string().min(1).max(255),
  byteSize: z.number().int().positive(),
  updatedAt: isoDate,
  visibility: z.literal('public'),
});

export const trustPagePublicPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotId: z.string().guid(),
  generatedAt: isoDate,
  publishedAt: isoDate,
  org: z.strictObject({
    name: z.string().min(1).max(255),
    logoUrl: logoUrl.nullable(),
    primaryColor: hexColor.nullable(),
    websiteUrl: httpsUrl.nullable(),
    securityContactEmail: z.string().email().max(320).nullable(),
  }),
  managedBy: z.strictObject({
    name: z.string().min(1).max(255),
    logoUrl: logoUrl.nullable(),
    websiteUrl: httpsUrl.nullable(),
  }).nullable(),
  introHtml: z.string().max(TRUST_INTRO_MAX_CHARS * 4).nullable(), // sanitized HTML may expand entities
  summary: z.strictObject({
    catalogTotal: z.number().int().positive(),
    controlsShown: z.number().int().min(0),
    controlsMet: z.number().int().min(0),
    deviceCount: z.number().int().min(0).nullable(),
  }),
  methodology: z.strictObject({
    catalogVersion: z.string().min(1),
    evidenceMaxAgeDays: z.number().int().positive(),
    definitionsMaxAgeDays: z.number().int().positive(),
    coverageFloorPct: z.number().int().min(0).max(100),
    thresholds: z.strictObject({ met: z.number().int(), attention: z.number().int() }),
    eligibilityNote: z.string().min(1).max(500),
  }),
  controls: z.array(trustPagePublicControlSchema).max(TELEMETRY_CONTROL_IDS.length),
  documents: z.array(trustPagePublicDocumentSchema).max(TRUST_DOCUMENTS_MAX),
  footer: z.strictObject({
    poweredByBreeze: z.boolean(),
    frameworkAttributions: z.array(trustFrameworkSchema).max(TRUST_FRAMEWORKS.length),
  }),
});
export type TrustPagePublicPayload = z.infer<typeof trustPagePublicPayloadSchema>;
export type TrustPagePublicControl = z.infer<typeof trustPagePublicControlSchema>;

export const trustPageUpdateSchema = z.strictObject({
  introHtml: z.string().max(TRUST_INTRO_MAX_CHARS).nullable().optional(),
  securityContactEmail: z.string().trim().email().max(320).nullable().optional(),
  websiteUrl: httpsUrl.nullable().optional(),
  hiddenControlIds: z.array(telemetryControlIdSchema).max(TELEMETRY_CONTROL_IDS.length).optional(),
  showPercentages: z.boolean().optional(),
  showDeviceCount: z.boolean().optional(),
  showManagedBy: z.boolean().optional(),
  searchIndexable: z.boolean().optional(),
});
export type TrustPageUpdateInput = z.infer<typeof trustPageUpdateSchema>;

export const trustPageDocumentsUpdateSchema = z.strictObject({
  documents: z.array(z.strictObject({
    documentId: z.string().guid(),
    visibility: z.literal('public'),
    disclosureConfirmed: z.boolean(),
  })).max(TRUST_DOCUMENTS_MAX),
}).superRefine((v, ctx) => {
  v.documents.forEach((d, i) => {
    if (d.visibility === 'public' && !d.disclosureConfirmed) {
      ctx.addIssue({ code: 'custom', path: ['documents', i, 'disclosureConfirmed'], message: 'public documents need disclosure confirmation' });
    }
  });
  if (new Set(v.documents.map((d) => d.documentId)).size !== v.documents.length) {
    ctx.addIssue({ code: 'custom', path: ['documents'], message: 'duplicate document' });
  }
});

export const trustPagePublishSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  authorization: z.strictObject({ authorizedBy: z.string().trim().min(2).max(200) }).optional(),
});
export const trustPagePartnerHomeSchema = z.strictObject({ isPartnerHome: z.boolean() });

/**
 * The publication config frozen onto trust_pages.published_config at publish
 * (spec §19 item 17). The hourly refresh rebuilds from THIS, not the draft
 * columns, so draft edits reach the public page only through another publish.
 * Evidence and live document links are still re-read on refresh: the public
 * documents are documentIds ∩ live/public/confirmed/not-superseded links.
 */
export const trustPublishedConfigSchema = z.strictObject({
  hiddenControlIds: z.array(telemetryControlIdSchema).max(TELEMETRY_CONTROL_IDS.length),
  showPercentages: z.boolean(),
  showDeviceCount: z.boolean(),
  showManagedBy: z.boolean(),
  searchIndexable: z.boolean(),
  introHtml: z.string().max(TRUST_INTRO_STORED_MAX_CHARS).nullable(),
  websiteUrl: z.string().max(2048).nullable(),
  securityContactEmail: z.string().max(320).nullable(),
  documentIds: z.array(z.string().guid()).max(TRUST_DOCUMENTS_MAX),
});
export type TrustPublishedConfig = z.infer<typeof trustPublishedConfigSchema>;
