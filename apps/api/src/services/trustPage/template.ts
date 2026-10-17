// Owner: W02g (partner-wide trust page template, shape 3) — Trust Center W2 (#8770, spec §18.8, §19 item 33).
// One row per partner (trust_page_templates.partner_id UNIQUE). Every read and write runs under the CALLER's db
// context: partner scope passes breeze_has_partner_access(partner_id) for its own partner, system scope passes,
// and an org-scoped context sees nothing (the trust page routes are partner/system scope only).
import { and, eq, sql } from 'drizzle-orm';
import { TELEMETRY_CONTROL_IDS, TRUST_FRAMEWORKS, type TelemetryControlId, type TrustFramework, type TrustTemplateSettings } from '@breeze/shared';
import { db } from '../../db';
import { trustPageTemplates, type TrustPageTemplateRow } from '../../db/schema';

const KNOWN_CONTROL_IDS = new Set<string>(TELEMETRY_CONTROL_IDS);
const KNOWN_FRAMEWORKS = new Set<string>(TRUST_FRAMEWORKS);

export interface PartnerTemplate { settings: TrustTemplateSettings; revision: number }

/** A stored row as one level of the inheritance chain. Ids a later catalog dropped are ignored, as for the page. */
export function templateRowToSettings(row: TrustPageTemplateRow): TrustTemplateSettings {
  return {
    introHtml: row.introHtml ?? null,
    searchIndexable: row.searchIndexable ?? null,
    showPercentages: row.showPercentages ?? null,
    showDeviceCount: row.showDeviceCount ?? null,
    showManagedBy: row.showManagedBy ?? null,
    showHistory: row.showHistory ?? null,
    hiddenControlIds: row.hiddenControlIds ? row.hiddenControlIds.filter((id): id is TelemetryControlId => KNOWN_CONTROL_IDS.has(id)) : null,
    frameworkView: row.frameworkView ? row.frameworkView.filter((fw): fw is TrustFramework => KNOWN_FRAMEWORKS.has(fw)) : null,
  };
}

/** null = the partner has no template row (every setting falls through to the built-in default). */
export async function loadPartnerTemplate(partnerId: string): Promise<PartnerTemplate | null> {
  const [row] = await db.select().from(trustPageTemplates).where(eq(trustPageTemplates.partnerId, partnerId)).limit(1);
  return row ? { settings: templateRowToSettings(row), revision: row.revision } : null;
}

/** The writable columns. Omitted = unchanged; null = cleared (falls through to the built-in default). */
export type PartnerTemplatePatch = Partial<Pick<typeof trustPageTemplates.$inferInsert,
  'introHtml' | 'searchIndexable' | 'showPercentages' | 'showDeviceCount' | 'showManagedBy' | 'showHistory' | 'hiddenControlIds' | 'frameworkView'>>;

export type SavePartnerTemplateResult = ({ ok: true } & PartnerTemplate) | { ok: false; reason: 'REVISION_MISMATCH' };

/**
 * Optimistic-concurrency upsert in ONE statement, so two admins saving at once cannot both win:
 * - `expectedRevision` 0 (the form loaded "no template"): INSERT at revision 1; if a row already exists the
 *   ON CONFLICT update only fires while it is still at revision 0 (never, once anyone saved), else mismatch.
 * - otherwise: UPDATE … WHERE revision = expectedRevision; zero rows back = someone saved first (or the row is gone).
 * Every successful write bumps `revision`, which the org editor echoes on publish (409 TEMPLATE_CHANGED).
 */
export async function savePartnerTemplate(args: {
  partnerId: string; expectedRevision: number; patch: PartnerTemplatePatch; actorUserId: string;
}): Promise<SavePartnerTemplateResult> {
  const now = new Date();
  const set = { ...args.patch, revision: sql`${trustPageTemplates.revision} + 1`, updatedAt: now, updatedByUserId: args.actorUserId };
  const rows = args.expectedRevision === 0
    ? await db.insert(trustPageTemplates)
      .values({ ...args.patch, partnerId: args.partnerId, revision: 1, updatedByUserId: args.actorUserId })
      .onConflictDoUpdate({ target: trustPageTemplates.partnerId, set, setWhere: sql`${trustPageTemplates.revision} = 0` })
      .returning()
    : await db.update(trustPageTemplates).set(set)
      .where(and(eq(trustPageTemplates.partnerId, args.partnerId), eq(trustPageTemplates.revision, args.expectedRevision)))
      .returning();
  const [row] = rows;
  if (!row) return { ok: false, reason: 'REVISION_MISMATCH' };
  return { ok: true, settings: templateRowToSettings(row), revision: row.revision };
}
