// packages/shared/src/validators/trustCenter.ts
import { z } from 'zod';
import { TELEMETRY_CONTROL_IDS, TRUST_CONTROL_CATEGORY_ORDER, TRUST_FRAMEWORKS, W1_TELEMETRY_CONTROL_IDS } from '../trustCenter/types';
import { DECLARED_CONTROL_IDS } from '../trustCenter/declaredCatalog';
import { FRAMEWORK_CROSSWALK } from '../trustCenter/frameworkCrosswalk';
import { SUPPORTED_LOCALES } from '../utils/locale';

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

/** Max safeguards one control may carry (W3e): bounded well above the mapped set so the payload cannot bloat. */
export const TRUST_CONTROL_SAFEGUARDS_MAX = 40;
/** Identifier + status + counts only; labels come from FRAMEWORK_CROSSWALK at render time (spec §5.5, §18.13). */
export const trustPublicSafeguardSchema = z.strictObject({
  framework: z.literal('cis_v8'),
  ref: z.string().min(1).max(32),
  status: trustControlStatusSchema,
  reason: trustNotAssessedReasonSchema.nullable(),
  percent: z.number().int().min(0).max(100).nullable(),
  assessed: z.number().int().min(0).nullable(),
  eligible: z.number().int().min(0).nullable(),
});

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
  /** hardening_baseline only, only while the CIS framework view is on (W3e). Optional: older snapshots lack it. */
  safeguards: z.array(trustPublicSafeguardSchema).max(TRUST_CONTROL_SAFEGUARDS_MAX).optional(),
}).superRefine((c, ctx) => {
  if (c.safeguards !== undefined) {
    if (c.id !== 'hardening_baseline') {
      ctx.addIssue({ code: 'custom', path: ['safeguards'], message: 'only hardening_baseline may carry safeguards' });
    }
    const seen = new Set<string>();
    c.safeguards.forEach((sg, i) => {
      if (!FRAMEWORK_CROSSWALK.cis_v8[sg.ref]) {
        ctx.addIssue({ code: 'custom', path: ['safeguards', i, 'ref'], message: 'unknown CIS v8 safeguard' });
      }
      if (seen.has(sg.ref)) ctx.addIssue({ code: 'custom', path: ['safeguards', i, 'ref'], message: 'duplicate safeguard' });
      seen.add(sg.ref);
      if (sg.status === 'not_assessed' && (sg.percent !== null || sg.reason === null)) {
        ctx.addIssue({ code: 'custom', path: ['safeguards', i], message: 'not_assessed carries a reason and no percent' });
      }
      if (sg.status !== 'not_assessed' && sg.reason !== null) {
        ctx.addIssue({ code: 'custom', path: ['safeguards', i], message: 'reason only with not_assessed' });
      }
    });
  }
  if (c.status === 'not_assessed' && (c.percent !== null || c.reason === null)) {
    ctx.addIssue({ code: 'custom', message: 'not_assessed carries a reason and no percent' });
  }
  if (c.status !== 'not_assessed' && c.reason !== null) {
    ctx.addIssue({ code: 'custom', message: 'reason only with not_assessed' });
  }
});


export const trustDocumentVisibilitySchema = z.enum(['public', 'gated']);
export type TrustDocumentVisibility = z.infer<typeof trustDocumentVisibilitySchema>;

const publicDocumentShape = {
  id: z.string().guid(),
  title: z.string().min(1).max(200),
  category: z.enum(['baseline', 'runbook', 'policy', 'evidence', 'report', 'export', 'other']),
  contentType: z.string().min(1).max(255),
  byteSize: z.number().int().positive(),
  updatedAt: isoDate,
};
/** W1 (schemaVersion 1): every listed document was public. */
const trustPagePublicDocumentV1Schema = z.strictObject({ ...publicDocumentShape, visibility: z.literal('public') });
/** v2: a gated document is listed (title only) and requested through the access flow (W02d). */
export const trustPagePublicDocumentSchema = z.strictObject({ ...publicDocumentShape, visibility: trustDocumentVisibilitySchema });

/** A list of distinct frameworks (framework view selection, payload `frameworks`). */
const frameworkListSchema = z.array(trustFrameworkSchema).max(TRUST_FRAMEWORKS.length)
  .refine((v) => new Set(v).size === v.length, 'duplicate framework');

export const TRUST_NDA_MAX_CHARS = 10_000;
export const TRUST_SUBPROCESSORS_MAX = 50;
export const TRUST_FAQ_MAX = 30;
export const TRUST_FAQ_ANSWER_MAX_CHARS = 16_000;
export const TRUST_HISTORY_MAX_POINTS = 200;

export const trustPagePublicDeclaredControlSchema = z.strictObject({
  id: z.enum(DECLARED_CONTROL_IDS),
  category: z.enum(TRUST_CONTROL_CATEGORY_ORDER),
  source: z.literal('declared'),
  status: z.enum(['current', 'expired']),
  statement: z.string().min(1).max(1000),
  declaredBy: z.string().min(1).max(255),
  declaredAt: isoDate,
  expiresAt: isoDate,
  evidenceDocumentId: z.string().guid().nullable(),
  frameworkRefs: z.array(frameworkRefSchema).max(12),
});
export const trustPagePublicSubprocessorSchema = z.strictObject({
  name: z.string().min(1).max(200),
  purpose: z.string().min(1).max(300),
  location: z.string().max(120).nullable(),
  websiteUrl: httpsUrl.nullable(),
});
export const trustPagePublicFaqItemSchema = z.strictObject({
  question: z.string().min(1).max(300),
  answerHtml: z.string().max(TRUST_FAQ_ANSWER_MAX_CHARS),
});
export const trustPageHistoryPointSchema = z.strictObject({
  at: isoDate,
  met: z.number().int().min(0),
  shown: z.number().int().min(0),
});

const payloadBaseShape = {
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
  introHtml: z.string().max(TRUST_INTRO_MAX_CHARS * 8).nullable(), // sanitized HTML expands up to ~6x (entities, anchor attributes); 8x bounds the worst case
  summary: z.strictObject({
    catalogTotal: z.number().int().positive(),
    controlsShown: z.number().int().min(0),
    /** Telemetry controls only; declared controls are never counted here (amendment 27). */
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
  footer: z.strictObject({
    poweredByBreeze: z.boolean(),
    frameworkAttributions: z.array(trustFrameworkSchema).max(TRUST_FRAMEWORKS.length),
  }),
};

/** The W1 payload, unchanged. Stored v1 snapshots stay readable through `normalizeTrustPagePayload`. */
export const trustPagePublicPayloadV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  ...payloadBaseShape,
  documents: z.array(trustPagePublicDocumentV1Schema).max(TRUST_DOCUMENTS_MAX),
});

/** The public exposure boundary (spec §6; amendment 29). Closed at every level and size-bounded. */
export const trustPagePublicPayloadSchema = z.strictObject({
  schemaVersion: z.literal(2),
  locale: z.enum(SUPPORTED_LOCALES),
  ...payloadBaseShape,
  documents: z.array(trustPagePublicDocumentSchema).max(TRUST_DOCUMENTS_MAX),
  declaredControls: z.array(trustPagePublicDeclaredControlSchema).max(DECLARED_CONTROL_IDS.length),
  frameworks: frameworkListSchema,
  subprocessors: z.array(trustPagePublicSubprocessorSchema).max(TRUST_SUBPROCESSORS_MAX),
  faq: z.array(trustPagePublicFaqItemSchema).max(TRUST_FAQ_MAX),
  history: z.array(trustPageHistoryPointSchema).max(TRUST_HISTORY_MAX_POINTS),
  access: z.strictObject({ ndaText: z.string().max(TRUST_NDA_MAX_CHARS).nullable() }).nullable(),
});
export type TrustPagePublicPayload = z.infer<typeof trustPagePublicPayloadSchema>;
export type TrustPagePublicPayloadV1 = z.infer<typeof trustPagePublicPayloadV1Schema>;
export type TrustPagePublicPayloadAny = TrustPagePublicPayloadV1 | TrustPagePublicPayload;
export type TrustPagePublicControl = z.infer<typeof trustPagePublicControlSchema>;
export type TrustPagePublicDocument = z.infer<typeof trustPagePublicDocumentSchema>;
export type TrustPagePublicDeclaredControl = z.infer<typeof trustPagePublicDeclaredControlSchema>;

/**
 * The only place that knows payload v1 exists. Every read path (API cache/route, portal) passes a stored or
 * fetched payload through this before use. A v1 payload is English, every listed document is public, and it
 * carries no W2 block.
 */
export function normalizeTrustPagePayload(p: TrustPagePublicPayloadAny): TrustPagePublicPayload {
  if (p.schemaVersion === 2) return p;
  return {
    ...p,
    schemaVersion: 2,
    locale: 'en',
    documents: p.documents.map((d) => ({ ...d, visibility: 'public' as const })),
    declaredControls: [], frameworks: [], subprocessors: [], faq: [], history: [], access: null,
  };
}

/** null = inherit (partner template → built-in default, `resolveEffectiveTrustSettings`). */
const inheritableBoolean = z.boolean().nullable().optional();

export const trustPageUpdateSchema = z.strictObject({
  /** null = inherit; '' (or HTML that sanitizes to nothing) = explicitly no intro. */
  introHtml: z.string().max(TRUST_INTRO_MAX_CHARS).nullable().optional(),
  securityContactEmail: z.string().trim().email().max(320).nullable().optional(),
  websiteUrl: httpsUrl.nullable().optional(),
  hiddenControlIds: z.array(telemetryControlIdSchema).max(TELEMETRY_CONTROL_IDS.length).nullable().optional(),
  showPercentages: inheritableBoolean,
  showDeviceCount: inheritableBoolean,
  showManagedBy: inheritableBoolean,
  searchIndexable: inheritableBoolean,
  showHistory: inheritableBoolean,
  frameworkView: frameworkListSchema.nullable().optional(),
  ndaText: z.string().trim().max(TRUST_NDA_MAX_CHARS).nullable().optional(),
  accessRequestCreatesTicket: z.boolean().optional(),
  /** Enforced when sent (amendment 34): a stale value → 409 REVISION_MISMATCH. */
  expectedRevision: z.number().int().min(0).optional(),
});
export type TrustPageUpdateInput = z.infer<typeof trustPageUpdateSchema>;

export const trustPageDocumentsUpdateSchema = z.strictObject({
  documents: z.array(z.strictObject({
    documentId: z.string().guid(),
    visibility: trustDocumentVisibilitySchema,
    disclosureConfirmed: z.boolean(),
  })).max(TRUST_DOCUMENTS_MAX),
  expectedRevision: z.number().int().min(0).optional(),
}).superRefine((v, ctx) => {
  v.documents.forEach((d, i) => {
    // Gated documents are disclosed to approved requesters, so they need the same confirmation (amendment 35).
    if (!d.disclosureConfirmed) {
      ctx.addIssue({ code: 'custom', path: ['documents', i, 'disclosureConfirmed'], message: 'linked documents need disclosure confirmation' });
    }
  });
  if (new Set(v.documents.map((d) => d.documentId)).size !== v.documents.length) {
    ctx.addIssue({ code: 'custom', path: ['documents'], message: 'duplicate document' });
  }
});

export const trustPagePublishSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  authorization: z.strictObject({ authorizedBy: z.string().trim().min(2).max(200) }).optional(),
  /** The partner template revision the editor loaded (null = no template); 409 TEMPLATE_CHANGED on mismatch. */
  expectedTemplateRevision: z.number().int().min(0).nullable().optional(),
});
export const trustPagePartnerHomeSchema = z.strictObject({ isPartnerHome: z.boolean() });

const frozenSubprocessorSchema = trustPagePublicSubprocessorSchema.extend({ sortOrder: z.number().int().min(0) }).strict();

/**
 * The publication config frozen onto trust_pages.published_config at publish (spec §19 items 17, 28).
 * The hourly refresh rebuilds from THIS, not the draft columns, so draft edits reach the public page only
 * through another publish. Evidence, live document links and declaration withdrawal/expiry are still re-read.
 * The W1 fields are required; every W2 field is optional or defaulted so a W1 config still parses, and
 * `resolveFrozenConfig` gives each missing W2 field its W1 meaning.
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
  /** W1 back-compat: always written; equals documents[].id. */
  documentIds: z.array(z.string().guid()).max(TRUST_DOCUMENTS_MAX),
  documents: z.array(z.strictObject({ id: z.string().guid(), visibility: trustDocumentVisibilitySchema })).max(TRUST_DOCUMENTS_MAX).optional(),
  catalogControlIds: z.array(telemetryControlIdSchema).max(TELEMETRY_CONTROL_IDS.length).optional(),
  declarationIds: z.array(z.string().guid()).max(DECLARED_CONTROL_IDS.length).default([]),
  frameworkView: frameworkListSchema.optional(),
  showHistory: z.boolean().default(false),
  subprocessors: z.array(frozenSubprocessorSchema).max(TRUST_SUBPROCESSORS_MAX).default([]),
  faq: z.array(trustPagePublicFaqItemSchema).max(TRUST_FAQ_MAX).default([]),
  ndaText: z.string().max(TRUST_NDA_MAX_CHARS).nullable().default(null),
  locale: z.enum(SUPPORTED_LOCALES).default('en'),
});
export type TrustPublishedConfig = z.infer<typeof trustPublishedConfigSchema>;
export type TrustPublishedConfigResolved = Required<TrustPublishedConfig>;

/** A parsed frozen config with every W2 field present; missing W2 fields take their W1 meaning (Global Constraints). */
export function resolveFrozenConfig(c: TrustPublishedConfig): TrustPublishedConfigResolved {
  return {
    ...c,
    documents: c.documents ?? c.documentIds.map((id) => ({ id, visibility: 'public' as const })),
    catalogControlIds: c.catalogControlIds ?? [...W1_TELEMETRY_CONTROL_IDS],
    frameworkView: c.frameworkView ?? [],
  };
}
